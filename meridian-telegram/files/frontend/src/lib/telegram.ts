import { authHeaders } from "@/lib/auth";

// Раздел «Telegram» (backend/app/routers/telegram.py). Клиент Telegram Web K
// раздаётся nginx'ом как /tg/ (public/tg/) и ходит к Telegram через /tgws/ на этом же
// хосте. iframe и WebSocket не умеют слать Authorization, поэтому API по обычному
// Bearer выдаёт отдельную httpOnly-куку — её и проверяют /tg/ и /tgws/.

export const TELEGRAM_PERMISSION = "telegram";
export const TELEGRAM_CLIENT_URL = "/tg/";
// Кука живёт 12 ч — продлеваем, пока страница открыта (с запасом на сон ноутбука).
export const TELEGRAM_SESSION_REFRESH_MS = 30 * 60 * 1000;

export async function openTelegramSession(): Promise<void> {
  const res = await fetch("/api/tg/session", { method: "POST", headers: authHeaders() });
  if (!res.ok) {
    if (res.status === 403) throw new Error("Нет доступа к разделу «Telegram» — обратитесь к администратору");
    throw new Error("Не удалось открыть сессию Telegram");
  }
}

/** Выход из Meridian: сервер удаляет куку и шлёт Clear-Site-Data — браузер стирает
 *  сессию Telegram (IndexedDB) и service worker клиента, следующий человек на этом
 *  же ПК чужой Telegram не увидит. Ошибки глотаем — выход не должен застревать. */
export async function closeTelegramSession(): Promise<void> {
  try {
    await fetch("/api/tg/session", { method: "DELETE" });
  } catch {
    /* сеть — выходим всё равно */
  }
}
