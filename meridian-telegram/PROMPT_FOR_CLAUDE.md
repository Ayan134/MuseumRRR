Задание для Claude Code на сервере Meridian. Скопируйте текст ниже целиком.

---

Внедри в Meridian раздел «Telegram» (Telegram Web K во вкладке, трафик через наш сервер).
Комплект лежит в `/opt/meridian-telegram/`. Если путь другой, спроси у меня. Сначала
прочитай `/opt/meridian-telegram/files/docs/telegram.md`, там описано устройство.

Порядок:

1. Убедись, что рабочее дерево репозитория Meridian чистое (`git status`), и создай ветку
   `feature/telegram`.
2. Примени изменения кода:
   `git apply --3way /opt/meridian-telegram/meridian-telegram.patch`.
   Если есть конфликты (код на сервере новее, чем тот, под который делался патч), разреши
   их, сохранив и наши, и серверные изменения. `frontend/src/routeTree.gen.ts`
   генерируется сам при сборке, конфликт в нём решай в пользу серверной версии и потом
   пересобери. Если `git apply` не работает совсем, возьми файлы из
   `/opt/meridian-telegram/files/`. Новые файлы копируй как есть, а изменённые
   (`main.py`, `requirements.txt`, `nginx.conf`, `app-sidebar.tsx`, `_auth.tsx`,
   `auth.ts`) не перезаписывай: внеси в них правки вручную, сверяясь с патчем.
3. Скопируй клиент Telegram (его нет в патче):
   `cp -r /opt/meridian-telegram/files/frontend/public/tg frontend/public/tg`.
   Проверь, что `frontend/public/tg/index.html` существует.
4. Миграция: у неё `down_revision = '0e1f2a3b4c5d'`. Если на сервере после этой ревизии
   уже есть другие миграции, поменяй `down_revision` в
   `backend/migrations/versions/7a1b2c3d4e5f_add_telegram_permission.py` на текущую
   голову, чтобы `alembic heads` показывал одну голову.
5. Проверь локально, если есть окружение: `cd backend && python -m pytest
   tests/test_telegram_router.py`, `cd frontend && npm ci && npm test && npm run build`.
6. Проверь, что из контейнера `api` есть выход к Telegram:
   `docker compose exec api python -c "import httpx; print(httpx.post('https://venus.web.telegram.org/apiw1', content=b'x', timeout=10).status_code)"`.
   Ответ с любым HTTP-кодом значит, что сеть есть; таймаут или ошибка значит, что её нет.
   В этом случае скажи мне: нужен `HTTPS_PROXY` в `.env` или открыть исходящий 443.
7. Пересобери и перезапусти:
   `docker compose build api worker beat frontend && docker compose up -d`,
   затем `docker compose exec api alembic upgrade head`. Если миграции у нас катятся
   иначе, сделай как принято в проекте (смотри README и docs/).
8. Напомни мне включить **Websockets Support** в Nginx Proxy Manager для proxy host
   Meridian. Без этого `/tgws/` не заработает.
9. Проверь:
   - `curl -s -o /dev/null -w '%{http_code}' https://<домен>/tg/` выдаёт 401;
   - `curl -s -o /dev/null -w '%{http_code}' https://<домен>/api/tg/auth` выдаёт 401;
   - в `docker compose logs api` нет ошибок импорта `websockets` и `telegram`.
   После этого попроси меня войти под admin, открыть «Telegram» и убедиться, что
   появился QR-код.
10. Закоммить изменения в ветку `feature/telegram`. Пуш и merge в main делай только
    после моего подтверждения.

Важно: право `telegram` не публичное. Admin и owner видят раздел сразу, остальным его
выдают в «Администратор». Если нужно открыть раздел всем, это одна SQL-команда, она
есть в `docs/telegram.md`. Перед этим спроси меня.
