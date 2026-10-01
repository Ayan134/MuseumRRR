# Раздел «Telegram»

Пункт меню **Telegram** (`/telegram`) — полноценный Telegram Web K
(https://github.com/morethanwords/tweb, GPL-3.0, коммит
`e55552763f3dcca269230bb7487213bbaf82ff6a`, версия 2.2 (676)) внутри Meridian, в iframe.
Браузер ходит только на хост Meridian, сервер — к Telegram:

| Клиент | Куда проксирует API |
|---|---|
| `wss://<хост>/tgws/kws{1-5}[-1]/apiws[_premium]` | `wss://kws…web.telegram.org/…` |
| `POST https://<хост>/tgws/{pluto,venus,aurora,vesta,flora}[-1]/apiw1` | `https://…web.telegram.org/apiw1` |

Имена и пути — белый список в `backend/app/routers/telegram.py`, остальное: WS 403,
POST 404. MTProto шифруется в браузере, сервер гоняет байты как есть. Сессия Telegram у
каждого своя, в IndexedDB его браузера; на сервере не хранится.

## Как устроено

| Часть | Файл |
|---|---|
| Клиент (готовая сборка, адреса DC уже переписаны на `/tgws/`) | `frontend/public/tg/` → в образе nginx `/usr/share/nginx/html/tg/` |
| Прокси MTProto, выдача/проверка куки | `backend/app/routers/telegram.py` |
| nginx: `/tg/` (статика за `auth_request`), `/tgws/` (WS + POST в API) | `frontend/nginx.conf` |
| Страница раздела (шапка, iframe, ошибки) | `frontend/src/components/telegram/telegram-panel.tsx` |
| Роут (только проверка права) | `frontend/src/routes/_auth/telegram.tsx` |
| Право `telegram` | `backend/migrations/versions/7a1b2c3d4e5f_add_telegram_permission.py` |
| Обновление клиента | `scripts/tg_patch.py` |

**Авторизация.** Основной API — JWT в `Authorization`, но iframe, статика и WebSocket
заголовок приложить не могут. Страница `/telegram` делает `POST /api/tg/session` (Bearer +
право `telegram`) и получает httpOnly-куку `meridian_tg` (отдельный JWT со `scope=tg`,
12 ч, страница продлевает её каждые 30 мин). Её проверяют nginx (`auth_request` →
`GET /api/tg/auth`) перед каждым файлом `/tg/` и сам прокси `/tgws/`. У WebSocket
дополнительно Origin должен совпадать с Host. Исключение — скрипт service worker'а
`/tg/sw-*.js`: Chromium запрашивает его без куки.

**Панель живёт в layout.** `TelegramPanel` смонтирован в `routes/_auth.tsx` и при уходе в
другой раздел только прячется — клиент не перезагружается и не теряет соединение.

**Выход.** «Выйти» в сайдбаре (и авто-выход по 401) зовёт `DELETE /api/tg/session`: кука
удаляется, ответ несёт `Clear-Site-Data: "storage"` — браузер стирает IndexedDB,
localStorage, service worker сайта. Следующий человек на том же профиле браузера чужой
Telegram не увидит. Побочный эффект: сбрасывается и выбранная тема Meridian.

**Права.** Ключ `telegram`, `is_public=false`: admin/owner видят раздел сразу,
остальным — выдать в «Администратор → Пользователи/Роли». Открыть всем:
`UPDATE feature_permissions SET is_public = true WHERE key = 'telegram';`

## Требования к серверу

- Исходящий доступ из контейнера `api` к `*.web.telegram.org:443`. Если выход через
  прокси — `HTTPS_PROXY` в `.env` (подхватывают и `httpx`, и `websockets>=15`).
- HTTPS: клиент всегда строит `wss://` и `https://`, service worker не регистрируется
  на недоверенном сертификате.
- Nginx Proxy Manager: в proxy host Meridian включить **Websockets Support** (иначе
  `/tgws/` не апгрейдится). NPM пробрасывает исходный Host — это нужно для проверки
  Origin == Host.
- Meridian должен быть в корне домена: адрес `/tgws/` в клиенте абсолютный.

## Как проверить

1. Без входа: `https://<хост>/tg/` → 302 на `/telegram` (→ `/login`); `curl` без куки — 401.
2. Пользователь с правом `telegram` видит пункт меню, в нём экран входа Telegram (QR /
   номер телефона).
3. DevTools → Network → WS: соединение `wss://<хост>/tgws/kws2/apiws`, запросов на
   `*.telegram.org` нет.
4. QR появляется, вход по номеру присылает код. Если QR крутится бесконечно —
   `docker compose logs api | grep "tg "`: строки `tg ws connect …` / `tg http …` значат,
   что сервер не достучался до Telegram (сеть/прокси).

## Как обновить клиент

`frontend/public/tg/` — официальная готовая сборка из `public/` репозитория tweb.

```
git clone --recurse-submodules https://github.com/morethanwords/tweb
python scripts/tg_patch.py build <tweb>/public          # готовая сборка
# или из исходников (Node ^22.18 / ≥24.11, pnpm):
cd tweb && pnpm install && pnpm exec vite build && python <meridian>/scripts/tg_patch.py build dist
```

`tg_patch.py build` копирует сборку в `frontend/public/tg/` (без `.map`) и заменяет адреса
DC в JS. Если шаблон адреса не найден — падает с ошибкой: значит, tweb поменял
`src/lib/mtproto/dcConfigurator.ts`, надо поправить регулярки. Затем пересобрать образ
`frontend`. У пользователей старый клиент держит service worker — обновится при следующей
загрузке вкладки.

## Что не работает через прокси

Оплаты (api.stripe.com и др.), web-push уведомления, внешние ссылки (t.me, telegram.org)
— открываются в браузере напрямую. Мини-приложения ботов грузятся с внешних доменов —
CSP `/tg/` их не пустит.
