import time
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.openapi.docs import get_swagger_ui_html
from fastapi.openapi.utils import get_openapi
from fastapi.responses import HTMLResponse, RedirectResponse
from sqlalchemy.orm import Session
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

from app.config import settings
from app.database import get_db
from app.utils.logging import get_logger, setup_logging

setup_logging()
logger = get_logger("isnaverse.api")

from app.dependencies import require_admin
from app.models.user import User
from app.routers import admin, admin_audit, analytics, api_keys, auth, code_registry, dashboard, employee_aliases, integrations, notifications, period_reports, profile, projects, reconciliation_alerts, registration, reports, roles, scheduler, telegram, ticket_parsing, tickets, tools
from app.tracker import router as tracker_router
import app.models  # noqa: F401 — регистрирует все модели в mapper registry, см. models/__init__.py
import app.tracker.models  # noqa: F401 — отдельный пакет (docs/architecture-backend.md), не в models/__init__.py

# ── Prometheus метрики ───────────────────────────────────────────────────────
try:
    from prometheus_client import Counter, Histogram, generate_latest, CONTENT_TYPE_LATEST

    http_requests_total = Counter(
        "http_requests_total",
        "Total HTTP requests",
        ["method", "path", "status"],
    )
    http_request_duration_seconds = Histogram(
        "http_request_duration_seconds",
        "HTTP request duration in seconds",
        ["method", "path"],
        buckets=[0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0],
    )
    _PROMETHEUS_OK = True
    logger.info("Prometheus metrics enabled at /metrics")
except ImportError:
    _PROMETHEUS_OK = False
    logger.warning("prometheus-client not installed — /metrics disabled")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("isnaverse API starting up")
    from app.tasks import refresh_q19, refresh_smax
    refresh_q19.delay()
    refresh_smax.delay()
    logger.info("startup tasks dispatched: refresh_q19, refresh_smax")
    yield
    logger.info("isnaverse API shutting down")
    await telegram.shutdown()


limiter = Limiter(key_func=get_remote_address)

# root_path="/api" — nginx (прод и dev-прокси Vite) держит FastAPI ЗА префиксом /api/
# и обрезает его перед форвардом (см. .claude/rules/frontend.md, "Router prefix —
# FastAPI-роутеры без /api"), приложение само об этом префиксе не знает. Без root_path
# встроенный Swagger UI (/docs) генерирует ссылку на схему как АБСОЛЮТНЫЙ путь от корня
# домена (/openapi.json) — мимо /api, там её ловит SPA (index.html вместо JSON), и
# Swagger падает с "Parser error... end of the stream" (обнаружено 14.09.2026). root_path
# чинит и это, и "Try it out" (добавляет servers=[{"url": "/api"}] в саму схему) —
# на роутинг реальных запросов не влияет, только на то, какие URL FastAPI сам о себе
# рассказывает.
# docs_url/redoc_url/openapi_url=None — встроенный Swagger по умолчанию публичный,
# без авторизации, и отдаёт ВЕСЬ API (все роутеры — auth/admin/tickets/...), не только
# /integrations, которые единственно предназначены для внешнего потребителя (3-я линия).
# Ниже — свои /docs и /openapi.json за отдельной формой входа по РЕАЛЬНОМУ API-ключу
# (не отдельный Basic Auth-секрет — переиспользуем то, что и так уже храним в api_keys,
# см. _require_docs_key/_docs_login_page ниже), схема отфильтрована до tags=
# ["integrations"].
app = FastAPI(
    title="isnaverse API", version="0.1.0", lifespan=lifespan, root_path="/api",
    docs_url=None, redoc_url=None, openapi_url=None,
)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.allowed_origins.split(",") if o.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def observe_requests(request: Request, call_next):
    # Не логируем /metrics и /health — шум
    skip = request.url.path in ("/metrics", "/health")
    start = time.perf_counter()

    response = await call_next(request)

    elapsed = time.perf_counter() - start
    status = response.status_code

    if not skip:
        logger.info(
            f"{request.method} {request.url.path} → {status}",
            extra={
                "http_method": request.method,
                "http_path": request.url.path,
                "http_status": status,
                "elapsed_ms": round(elapsed * 1000),
            },
        )
        if _PROMETHEUS_OK:
            http_requests_total.labels(
                method=request.method,
                path=request.url.path,
                status=str(status),
            ).inc()
            http_request_duration_seconds.labels(
                method=request.method,
                path=request.url.path,
            ).observe(elapsed)

    return response


app.include_router(auth.router)
app.include_router(dashboard.router)
app.include_router(profile.router)
app.include_router(admin.router)
app.include_router(scheduler.router)
app.include_router(reports.router)
app.include_router(analytics.router)
app.include_router(tools.router)
app.include_router(projects.router)
app.include_router(tickets.router)
app.include_router(notifications.router)
app.include_router(period_reports.router)
app.include_router(employee_aliases.router)
app.include_router(code_registry.router)
app.include_router(reconciliation_alerts.router)
app.include_router(registration.router)
app.include_router(ticket_parsing.router)
app.include_router(api_keys.router)
app.include_router(integrations.router)
app.include_router(admin_audit.router)
app.include_router(roles.router)
app.include_router(tracker_router)
app.include_router(telegram.router)


# ── /docs, /openapi.json — вход по реальному API-ключу, схема ТОЛЬКО
# tags=["integrations"] ──────────────────────────────────────────────────────────
# Единственный сейчас предназначенный для внешнего потребителя (3-я линия) namespace
# — остальные ~15 роутеров (auth/admin/tickets/...) не должны быть видны в этой
# документации вообще, не только недоступны по данным (обнаружено 14.09.2026, см.
# докстринг FastAPI() выше).
#
# Ключ проверяется ЧЕРЕЗ ТОТ ЖЕ services.api_keys.verify_key, что и require_api_key
# (dependencies.py) — не отдельный секрет. Cookie, не Bearer-header: обычная навигация
# браузером по URL не может приложить кастомный header, а вот cookie браузер сам
# приложит и к странице /docs, и к последующему fetch('/openapi.json') с неё (тот же
# origin). Сама форма входа — HTML-страница с одним полем, отдаётся вместо Swagger,
# пока валидной cookie нет; после успешного POST выставляется cookie и редирект на /docs.
_DOCS_COOKIE = "meridian_docs_key"

_DOCS_LOGIN_PAGE = """<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>Meridian — документация API</title>
<style>
  body {{ font-family: -apple-system, "Segoe UI", sans-serif; background: #0f1216; color: #e7eaee;
         display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }}
  form {{ background: #161a20; border: 1px solid #262b33; border-radius: 12px; padding: 32px; width: 320px; }}
  h1 {{ font-size: 1.05rem; font-weight: 600; margin: 0 0 18px; }}
  input {{ width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 8px;
           border: 1px solid #262b33; background: #1c2027; color: #e7eaee; font-size: 0.9rem; margin-bottom: 12px; }}
  button {{ width: 100%; padding: 10px; border-radius: 8px; border: none; background: #5b9dff;
            color: #06121f; font-weight: 600; cursor: pointer; }}
  p.error {{ color: #f87171; font-size: 0.85rem; margin: -6px 0 12px; }}
</style></head>
<body>
  <form method="post" action="/api/docs/login">
    <h1>Документация API — вход по ключу</h1>
    {error_html}
    <input type="password" name="key" placeholder="API-ключ (mk_...)" autofocus required>
    <button type="submit">Войти</button>
  </form>
</body></html>"""


def _docs_login_html(error: bool = False) -> str:
    error_html = '<p class="error">Неверный или отозванный ключ</p>' if error else ""
    return _DOCS_LOGIN_PAGE.format(error_html=error_html)


def _docs_key_valid(db: Session, raw_key: str | None) -> bool:
    if not raw_key:
        return False
    from app.services.api_keys import verify_key
    return verify_key(db, raw_key) is not None


def _integrations_openapi() -> dict:
    schema = get_openapi(title=app.title, version=app.version, routes=app.routes)
    schema["paths"] = {
        path: ops for path, ops in schema["paths"].items()
        if any("integrations" in (op.get("tags") or []) for op in ops.values())
    }
    schema["servers"] = [{"url": "/api"}]
    return schema


@app.get("/docs", include_in_schema=False)
async def integrations_docs(request: Request, db: Session = Depends(get_db)):
    if not _docs_key_valid(db, request.cookies.get(_DOCS_COOKIE)):
        return HTMLResponse(_docs_login_html())
    return get_swagger_ui_html(openapi_url="/api/openapi.json", title="Meridian — интеграции")


@app.post("/docs/login", include_in_schema=False)
async def integrations_docs_login(request: Request, db: Session = Depends(get_db)):
    form = await request.form()
    raw_key = str(form.get("key", "")).strip()
    if not _docs_key_valid(db, raw_key):
        return HTMLResponse(_docs_login_html(error=True), status_code=401)
    response = RedirectResponse(url="/api/docs", status_code=303)
    response.set_cookie(
        _DOCS_COOKIE, raw_key, httponly=True, secure=(settings.app_env != "development"),
        samesite="lax", max_age=60 * 60 * 24 * 30, path="/api",
    )
    return response


@app.get("/openapi.json", include_in_schema=False)
async def integrations_openapi_json(request: Request, db: Session = Depends(get_db)):
    if not _docs_key_valid(db, request.cookies.get(_DOCS_COOKIE)):
        raise HTTPException(status_code=401)
    return _integrations_openapi()


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/metrics", include_in_schema=False)
async def metrics(_: User = Depends(require_admin)):
    if not _PROMETHEUS_OK:
        return Response("prometheus-client not installed", status_code=503)
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)
