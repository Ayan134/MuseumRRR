# Telegram для Meridian: комплект для установки

Раздел **«Telegram»** для Meridian: отдельный пункт в сайдбаре, страница в дизайне Meridian
(шапка, карточка, светлая и тёмная тема), внутри клиент Telegram Web K. Весь трафик идёт
через сервер Meridian. Это перенос `tg_deploy` со старого SQLite-дашборда на архитектуру
Meridian: FastAPI + JWT, React/TanStack, nginx, Nginx Proxy Manager.

## Что в папке

| Путь | Что это |
|---|---|
| `meridian-telegram.patch` | Изменения кода одним патчем, без клиента Telegram. Применять через `git apply --3way` |
| `files/` | Те же файлы целиком, в структуре репозитория Meridian, **плюс** `files/frontend/public/tg/` (клиент Telegram, ~53 МБ, адреса уже пропатчены) |
| `PROMPT_FOR_CLAUDE.md` | Готовое задание для Claude на сервере |
| `files/docs/telegram.md` | Как всё устроено, что проверить, как обновлять клиент |

### Какие файлы изменены в Meridian

Новые:
- `backend/app/routers/telegram.py`: прокси MTProto (`/tgws/…`), кука сессии (`/tg/session`), проверка для nginx (`/tg/auth`)
- `backend/migrations/versions/7a1b2c3d4e5f_add_telegram_permission.py`: право `telegram`
- `backend/tests/test_telegram_router.py`: 14 тестов
- `frontend/src/components/telegram/telegram-panel.tsx`: страница раздела
- `frontend/src/routes/_auth/telegram.tsx`: роут `/telegram`, проверка права
- `frontend/src/lib/telegram.ts`: открытие и закрытие сессии
- `frontend/public/tg/`: клиент Telegram Web K
- `scripts/tg_patch.py`: обновление клиента
- `docs/telegram.md`

Изменённые:
- `backend/app/main.py`: подключён роутер
- `backend/requirements.txt`: `websockets>=15`
- `frontend/nginx.conf`: блоки `/tg/` и `/tgws/`
- `frontend/src/components/app-sidebar.tsx`: пункт «Telegram», выход гасит сессию TG
- `frontend/src/routes/_auth.tsx`: панель Telegram в layout (iframe не перезагружается при смене раздела)
- `frontend/src/lib/auth.ts`: при протухшем входе сессия TG тоже гасится
- `frontend/src/routeTree.gen.ts`: генерируется при сборке

## Как установить с помощью Claude

1. Скопируйте папку `meridian-telegram/` на сервер рядом с репозиторием Meridian,
   например `scp -r meridian-telegram root@<IP>:/opt/`.
2. Запустите Claude Code в папке репозитория Meridian и дайте ему текст из
   `PROMPT_FOR_CLAUDE.md`. Путь к комплекту в тексте поправьте, если он другой.
3. Вручную в Nginx Proxy Manager: в proxy host Meridian включите **Websockets Support**.

Как проверено:
- backend: 1485 тестов pytest, одна голова Alembic;
- frontend: `tsc` + `vite build` и 531 тест vitest;
- nginx: конфиг прошёл `nginx -t`, все пути проверены через живой nginx (статика за
  авторизацией, редирект, service worker, wasm/js MIME, WebSocket с куки и без, чужой Origin);
- страница снята скриншотами в светлой и тёмной теме.

Реальное подключение к Telegram не проверено: из тестовой среды нет выхода на
`*.web.telegram.org`. Его нужно проверить на сервере (п. 4 в `docs/telegram.md`).
