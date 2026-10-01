"""Telegram во вкладке Meridian (раздел «Telegram», право "telegram").

Клиент — Telegram Web K (https://github.com/morethanwords/tweb, GPL-3.0), готовая
сборка лежит во фронтенде (frontend/public/tg/ → раздаётся nginx'ом как /tg/).
Адреса дата-центров в сборке переписаны (scripts/tg_patch.py) на этот же хост, поэтому
браузер ходит только на Meridian, а сервер — к Telegram:

  /tgws/{name}/{path}  (WS)   — wss://{name}.web.telegram.org/{path}
  /tgws/{name}/{path}  (POST) — https://{name}.web.telegram.org/{path}

Имена и пути — только из белого списка ниже: это не открытый прокси. MTProto
шифруется в браузере, сервер гоняет байты как есть; сессия Telegram живёт в IndexedDB
браузера пользователя и на сервере не хранится.

Авторизация. Остальной API — JWT в заголовке Authorization (localStorage), но iframe,
статика и WebSocket заголовок приложить не могут. Поэтому страница /telegram сначала
делает POST /api/tg/session (обычный Bearer + право "telegram") и получает httpOnly-куку
TG_COOKIE — отдельный короткий JWT со scope="tg". Её проверяют:
  - GET /tg/auth — nginx auth_request перед раздачей статики /tg/;
  - /tgws/... — сам прокси (WS дополнительно сверяет Origin с Host).
DELETE /api/tg/session (выход из Meridian) стирает куку и шлёт Clear-Site-Data:
"storage" — браузер удаляет IndexedDB/service worker, следующий человек на этом же ПК
чужой Telegram не увидит.

nginx: /api/tg/... приходит сюда как /tg/... (префикс /api обрезается), /tgws/...
проксируется без обрезки — см. frontend/nginx.conf.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit

import httpx
import websockets
from fastapi import APIRouter, Depends, HTTPException, Request, Response, WebSocket
from jose import JWTError, jwt
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.dependencies import get_current_user
from app.models.user import User
from app.services.permissions import compute_effective_permissions
from app.utils.logging import get_logger

logger = get_logger("isnaverse.routers.telegram")
router = APIRouter(tags=["telegram"])

PERMISSION_KEY = "telegram"
TG_COOKIE = "meridian_tg"
TG_SCOPE = "tg"
# Страница /telegram продлевает куку каждые 30 минут, пока открыта (см.
# frontend/src/components/telegram/telegram-panel.tsx) — запас на сон ноутбука и т.п.
TG_SESSION_HOURS = 12

# Адреса DC — по tweb src/lib/mtproto/dcConfigurator.ts (App.suffix = 'K').
# WebSocket: k + ws + dcId(1..5) + ('' | '-1' для download/upload).
WS_NAMES = frozenset(f"kws{dc}{sfx}" for dc in range(1, 6) for sfx in ("", "-1"))
WS_PATHS = frozenset({"apiws", "apiws_premium", "apiws_test", "apiws_test_premium"})
# HTTPS-транспорт: sslSubdomains[dcId-1] + ('' | '-1').
HTTP_NAMES = frozenset(
    f"{n}{sfx}" for n in ("pluto", "venus", "aurora", "vesta", "flora") for sfx in ("", "-1")
)
HTTP_PATHS = frozenset({"apiw1", "apiw_test1"})
MAX_HTTP_BODY = 2 * 1024 * 1024  # MTProto-запрос с частью файла (до 512 КБ) + запас

# trust_env=True (по умолчанию) — подхватывает HTTPS_PROXY, если выход наружу через прокси.
_http = httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=10.0))


# ── кука сессии ──────────────────────────────────────────────────────────────

def _issue_token(user_id: int) -> str:
    expire = datetime.now(timezone.utc) + timedelta(hours=TG_SESSION_HOURS)
    return jwt.encode(
        {"sub": str(user_id), "scope": TG_SCOPE, "exp": expire},
        settings.app_secret_key,
        algorithm="HS256",
    )


def user_id_from_cookie(raw: str | None) -> int | None:
    """id пользователя из куки TG_COOKIE или None. Только подпись/срок/scope, без БД:
    вызывается на каждый файл статики (auth_request) и каждый MTProto-POST. Права
    проверяются при выдаче куки, а её срок ограничен TG_SESSION_HOURS."""
    if not raw:
        return None
    try:
        payload = jwt.decode(raw, settings.app_secret_key, algorithms=["HS256"])
    except JWTError:
        return None
    if payload.get("scope") != TG_SCOPE:
        # обычный access-токен Meridian (без scope) сюда не годится и наоборот
        return None
    try:
        return int(payload["sub"])
    except (KeyError, ValueError):
        return None


def _cookie_secure() -> bool:
    return settings.app_env != "development"


@router.post("/tg/session", status_code=204)
def open_session(
    response: Response,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Выдать куку для /tg/ и /tgws/ (вызывается страницей /telegram при открытии и
    периодически, пока она открыта)."""
    if not user.profile or PERMISSION_KEY not in compute_effective_permissions(user.profile, db):
        raise HTTPException(status_code=403, detail="Нет доступа к разделу «Telegram»")
    response.set_cookie(
        TG_COOKIE,
        _issue_token(user.id),
        max_age=TG_SESSION_HOURS * 3600,
        httponly=True,
        secure=_cookie_secure(),
        samesite="strict",
        path="/",
    )
    response.status_code = 204
    return response


@router.delete("/tg/session", status_code=204)
def close_session(response: Response):
    """Выход: удалить куку и стереть хранилище сайта (сессию Telegram в IndexedDB,
    service worker клиента). Без авторизации — должен срабатывать и с протухшим JWT.

    Clear-Site-Data чистит и localStorage — токен Meridian тоже уходит, это и есть
    выход; фронт всё равно удаляет его сам."""
    response.delete_cookie(TG_COOKIE, path="/", secure=_cookie_secure(), httponly=True, samesite="strict")
    response.headers["Clear-Site-Data"] = '"storage"'
    response.status_code = 204
    return response


@router.get("/tg/auth", include_in_schema=False)
def check_session(request: Request):
    """Для nginx auth_request перед раздачей /tg/: 204 — пускать, 401 — нет."""
    if user_id_from_cookie(request.cookies.get(TG_COOKIE)) is None:
        return Response(status_code=401)
    return Response(status_code=204)


# ── прокси MTProto ───────────────────────────────────────────────────────────

def _same_origin(headers) -> bool:
    """Защита от cross-site WebSocket: Origin должен совпадать с Host (nginx и Nginx
    Proxy Manager должны пробрасывать исходный Host) либо быть в ALLOWED_ORIGINS."""
    origin, host = headers.get("origin"), headers.get("host")
    if not origin:
        return False
    if host and urlsplit(origin).netloc == host:
        return True
    allowed = {o.strip().rstrip("/") for o in settings.allowed_origins.split(",") if o.strip()}
    return origin.rstrip("/") in allowed


@router.post("/tgws/{name}/{path}", include_in_schema=False)
async def tg_http(name: str, path: str, request: Request):
    """HTTPS-транспорт MTProto: POST бинарного тела, ответ — бинарный (клиент начинает
    с него и переходит на WebSocket, как только тот ответит)."""
    if name not in HTTP_NAMES or path not in HTTP_PATHS:
        return Response(status_code=404)
    if user_id_from_cookie(request.cookies.get(TG_COOKIE)) is None:
        return Response(status_code=401)
    body = bytearray()
    async for chunk in request.stream():
        body += chunk
        if len(body) > MAX_HTTP_BODY:
            return Response(status_code=413)
    try:
        # bytes(), не bytearray: bytearray httpx принимает за синхронный итератор
        r = await _http.post(
            f"https://{name}.web.telegram.org/{path}",
            content=bytes(body),
            headers={"Content-Type": "application/octet-stream"},
        )
    except httpx.HTTPError as e:
        logger.warning(f"tg http {name}/{path}: {type(e).__name__} {e}")
        return Response(status_code=502)
    return Response(
        r.content,
        status_code=r.status_code,
        media_type=r.headers.get("content-type", "application/octet-stream"),
    )


@router.websocket("/tgws/{name}/{path}")
async def tg_ws(ws: WebSocket, name: str, path: str):
    """WebSocket-транспорт MTProto: двунаправленная перекачка бинарных фреймов.
    Отказ (close до accept) Starlette отдаёт как HTTP 403 на рукопожатие."""
    if name not in WS_NAMES or path not in WS_PATHS:
        return await ws.close(code=1008)
    if not _same_origin(ws.headers) or user_id_from_cookie(ws.cookies.get(TG_COOKIE)) is None:
        return await ws.close(code=1008)

    offered = [p.strip() for p in ws.headers.get("sec-websocket-protocol", "").split(",") if p.strip()]
    subprotocol = "binary" if "binary" in offered else None
    url = f"wss://{name}.web.telegram.org/{path}"
    try:
        upstream = await websockets.connect(
            url,
            subprotocols=["binary"] if subprotocol else None,
            max_size=None,
            open_timeout=15,
            ping_interval=None,
            compression=None,
        )
    except Exception as e:  # сеть/TLS/отказ Telegram — клиент сам переподключится
        logger.warning(f"tg ws connect {url}: {type(e).__name__} {e}")
        return await ws.close(code=1011)

    await ws.accept(subprotocol=subprotocol)

    async def client_to_tg():
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                return
            data = msg.get("bytes")
            if data is None and msg.get("text") is not None:
                data = msg["text"]
            if data is not None:
                await upstream.send(data)

    async def tg_to_client():
        async for data in upstream:
            if isinstance(data, bytes):
                await ws.send_bytes(data)
            else:
                await ws.send_text(data)

    tasks = [asyncio.create_task(client_to_tg()), asyncio.create_task(tg_to_client())]
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await upstream.close()
        try:
            await ws.close()
        except Exception:
            pass


async def shutdown() -> None:
    """Закрыть пул соединений к Telegram (lifespan в main.py)."""
    await _http.aclose()
