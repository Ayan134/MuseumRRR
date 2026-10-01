"""routers/telegram.py — раздел «Telegram» (Telegram Web K во вкладке Meridian).

Приложение собирается с root_path="/api", как main.py: nginx обрезает /api у
/api/tg/session, а /tgws/... проксирует без обрезки — оба вида путей должны
маршрутизироваться. До Telegram тесты не ходят: апстрим подменяется (respx) либо
запрос отклоняется раньше."""
import os
from types import SimpleNamespace

os.environ.setdefault("APP_SECRET_KEY", "test-secret")
os.environ.setdefault("DATABASE_URL", "sqlite://")
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")
os.environ.setdefault("MINIO_URL", "http://localhost:9000")
os.environ.setdefault("MINIO_ROOT_USER", "test")
os.environ.setdefault("MINIO_ROOT_PASSWORD", "test")

import httpx
import pytest
import respx
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.database import get_db
from app.dependencies import get_current_user
from app.routers import telegram
from app.services.auth import create_access_token


def _user(permissions: set[str]):
    return SimpleNamespace(id=7, is_active=True, profile=SimpleNamespace(_perms=permissions))


@pytest.fixture()
def make_client(monkeypatch):
    def _make(permissions: set[str] = frozenset({"telegram"})):
        app = FastAPI(root_path="/api")
        app.include_router(telegram.router)
        app.dependency_overrides[get_current_user] = lambda: _user(set(permissions))
        app.dependency_overrides[get_db] = lambda: None
        monkeypatch.setattr(telegram, "compute_effective_permissions", lambda profile, db: profile._perms)
        return TestClient(app, base_url="https://meridian.test")
    return _make


def _cookie(client: TestClient) -> str:
    r = client.post("/tg/session")
    assert r.status_code == 204
    token = client.cookies.get(telegram.TG_COOKIE)
    # Пересаживаем без домена: cookiejar httpx не прикладывает куку из Set-Cookie к
    # ws://-рукопожатию TestClient (браузер прикладывает — тот же хост).
    client.cookies.clear()
    client.cookies.set(telegram.TG_COOKIE, token)
    return token


def test_session_sets_scoped_httponly_cookie(make_client):
    client = make_client()
    r = client.post("/tg/session")
    assert r.status_code == 204
    set_cookie = r.headers["set-cookie"]
    assert set_cookie.startswith(f"{telegram.TG_COOKIE}=")
    assert "HttpOnly" in set_cookie and "Path=/" in set_cookie and "SameSite=strict" in set_cookie
    assert telegram.user_id_from_cookie(client.cookies.get(telegram.TG_COOKIE)) == 7


def test_session_requires_permission(make_client):
    client = make_client(permissions=set())
    r = client.post("/tg/session")
    assert r.status_code == 403
    assert telegram.TG_COOKIE not in client.cookies


def test_auth_check_for_nginx(make_client):
    client = make_client()
    assert client.get("/tg/auth").status_code == 401
    _cookie(client)
    assert client.get("/tg/auth").status_code == 204


def test_regular_access_token_is_not_a_tg_cookie(make_client):
    """Обычный JWT Meridian (без scope) куку Telegram не заменяет."""
    client = make_client()
    client.cookies.set(telegram.TG_COOKIE, create_access_token(7))
    assert client.get("/tg/auth").status_code == 401
    assert telegram.user_id_from_cookie("garbage") is None


def test_logout_clears_cookie_and_site_storage(make_client):
    client = make_client()
    _cookie(client)
    r = client.delete("/tg/session")
    assert r.status_code == 204
    assert r.headers["clear-site-data"] == '"storage"'
    set_cookie = r.headers["set-cookie"]
    assert set_cookie.startswith(f'{telegram.TG_COOKIE}=""') and "Max-Age=0" in set_cookie


def test_http_transport_whitelist_and_auth(make_client):
    client = make_client()
    # не из белого списка — 404 даже с кукой: это не открытый прокси
    _cookie(client)
    assert client.post("/tgws/evil/apiw1", content=b"x").status_code == 404
    assert client.post("/tgws/venus/other", content=b"x").status_code == 404
    client.cookies.clear()
    assert client.post("/tgws/venus/apiw1", content=b"x").status_code == 401


def test_http_transport_body_limit(make_client):
    client = make_client()
    _cookie(client)
    r = client.post("/tgws/venus/apiw1", content=b"x" * (telegram.MAX_HTTP_BODY + 1))
    assert r.status_code == 413


@respx.mock
def test_http_transport_forwards_bytes(make_client):
    route = respx.post("https://venus.web.telegram.org/apiw1").mock(
        return_value=httpx.Response(200, content=b"\x01\x02", headers={"content-type": "application/octet-stream"})
    )
    client = make_client()
    _cookie(client)
    r = client.post("/tgws/venus/apiw1", content=b"\xff\x00")
    assert r.status_code == 200
    assert r.content == b"\x01\x02"
    assert route.calls.last.request.content == b"\xff\x00"


@pytest.mark.parametrize(
    "path, origin, with_cookie",
    [
        ("/tgws/kws2/apiws", "https://meridian.test", False),        # без куки
        ("/tgws/kws2/apiws", "https://evil.example", True),          # чужой Origin
        ("/tgws/evil/apiws", "https://meridian.test", True),         # не из белого списка
        ("/tgws/kws2/other", "https://meridian.test", True),
    ],
)
def test_ws_rejected(make_client, path, origin, with_cookie):
    client = make_client()
    if with_cookie:
        _cookie(client)
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect(path, headers={"origin": origin, "host": "meridian.test"}):
            pass
    assert exc.value.code == 1008


def test_same_origin():
    assert telegram._same_origin({"origin": "https://m.kz", "host": "m.kz"})
    assert telegram._same_origin({"origin": "https://m.kz:8443", "host": "m.kz:8443"})
    assert not telegram._same_origin({"origin": "https://m.kz", "host": "m.kz:8443"})
    assert not telegram._same_origin({"host": "m.kz"})
    assert telegram._same_origin({"origin": "http://localhost:5173", "host": "api:8000"})


class _FakeUpstream:
    """Подмена websockets.connect: отвечает эхом с префиксом."""

    def __init__(self):
        import asyncio
        self.queue = asyncio.Queue()
        self.closed = False

    async def send(self, data):
        await self.queue.put(b"tg:" + data)

    def __aiter__(self):
        return self

    async def __anext__(self):
        return await self.queue.get()

    async def close(self):
        self.closed = True


def test_ws_relays_binary_frames(make_client, monkeypatch):
    seen = {}

    async def fake_connect(url, **kwargs):
        seen["url"], seen["subprotocols"] = url, kwargs.get("subprotocols")
        seen["upstream"] = _FakeUpstream()
        return seen["upstream"]

    monkeypatch.setattr(telegram.websockets, "connect", fake_connect)
    client = make_client()
    _cookie(client)
    with client.websocket_connect(
        "/tgws/kws2/apiws",
        headers={"origin": "https://meridian.test", "host": "meridian.test"},
        subprotocols=["binary"],
    ) as ws:
        assert ws.accepted_subprotocol == "binary"
        ws.send_bytes(b"\x00\x01")
        assert ws.receive_bytes() == b"tg:\x00\x01"
    assert seen["url"] == "wss://kws2.web.telegram.org/apiws"
    assert seen["subprotocols"] == ["binary"]
