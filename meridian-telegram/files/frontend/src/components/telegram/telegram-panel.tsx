import { useCallback, useEffect, useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import { AlertTriangle, ExternalLink, Loader2, RotateCw, Send, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMe } from "@/lib/auth";
import { cn } from "@/lib/utils";
import {
  TELEGRAM_CLIENT_URL,
  TELEGRAM_PERMISSION,
  TELEGRAM_SESSION_REFRESH_MS,
  openTelegramSession,
} from "@/lib/telegram";

export const TELEGRAM_ROUTE = "/telegram";

type SessionState = { status: "loading" } | { status: "ready" } | { status: "error"; message: string };

/**
 * Раздел «Telegram». Живёт в _auth-layout, а не в самом роуте: роут /telegram
 * рендерит null, а эта панель монтируется при первом заходе и дальше только
 * прячется. Иначе каждый уход в другой раздел выгружал бы iframe — клиент
 * Telegram перезагружался бы заново и рвал соединение (уведомления, звонки).
 */
export function TelegramPanel() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { data: me } = useMe();
  // Сам роут без права уводит на /403 (beforeLoad); здесь — чтобы панель не успела
  // смонтироваться и дёрнуть /api/tg/session в момент этого редиректа.
  const allowed = me?.permissions.includes(TELEGRAM_PERMISSION) ?? false;
  const active = allowed && pathname === TELEGRAM_ROUTE;
  const [mounted, setMounted] = useState(active);

  useEffect(() => {
    if (active) setMounted(true);
  }, [active]);

  if (!mounted) return null;
  return <TelegramWorkspace active={active} />;
}

function TelegramWorkspace({ active }: { active: boolean }) {
  const [session, setSession] = useState<SessionState>({ status: "loading" });
  const [frameKey, setFrameKey] = useState(0);
  const [frameLoaded, setFrameLoaded] = useState(false);

  const connect = useCallback(async () => {
    setSession({ status: "loading" });
    try {
      await openTelegramSession();
      setSession({ status: "ready" });
    } catch (e) {
      setSession({ status: "error", message: e instanceof Error ? e.message : "Ошибка" });
    }
  }, []);

  useEffect(() => {
    void connect();
  }, [connect]);

  // Продлеваем куку, пока панель жива (в том числе скрытая — клиент работает в фоне).
  useEffect(() => {
    if (session.status !== "ready") return;
    const id = window.setInterval(() => {
      openTelegramSession().catch(() => {
        /* следующая попытка через интервал; при 401 interceptor сам уведёт на /login */
      });
    }, TELEGRAM_SESSION_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [session.status]);

  function reloadFrame() {
    setFrameLoaded(false);
    setFrameKey((k) => k + 1);
  }

  return (
    <section
      aria-label="Telegram"
      className={cn(
        "flex h-[calc(100dvh-3.5rem)] flex-col gap-4 p-4 md:h-dvh md:p-6",
        !active && "hidden",
      )}
    >
      <header className="flex flex-wrap items-center gap-4">
        <div className="grid size-11 shrink-0 place-items-center rounded-xl bg-sky-500/10 text-sky-500">
          <Send className="size-5" strokeWidth={1.75} />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Telegram</h1>
          <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
            <ShieldCheck className="size-3.5 shrink-0" strokeWidth={1.75} />
            <span className="truncate">
              Каждый входит в свой аккаунт; сессия хранится только в этом браузере и стирается при выходе из Meridian
            </span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={reloadFrame}
            disabled={session.status !== "ready"}
            title="Перезагрузить клиент Telegram"
          >
            <RotateCw strokeWidth={1.75} />
            Обновить
          </Button>
          <Button variant="outline" size="sm" asChild>
            <a href={TELEGRAM_CLIENT_URL} target="_blank" rel="noopener">
              <ExternalLink strokeWidth={1.75} />
              В новой вкладке
            </a>
          </Button>
        </div>
      </header>

      <div className="relative min-h-[360px] flex-1 overflow-hidden rounded-xl border border-border bg-card shadow-xs">
        {session.status === "ready" && (
          <iframe
            key={frameKey}
            src={TELEGRAM_CLIENT_URL}
            title="Telegram"
            allow="clipboard-read; clipboard-write; microphone; camera; autoplay; fullscreen"
            onLoad={() => setFrameLoaded(true)}
            className={cn(
              "absolute inset-0 size-full border-0 transition-opacity duration-300",
              frameLoaded ? "opacity-100" : "opacity-0",
            )}
          />
        )}

        {(session.status === "loading" || (session.status === "ready" && !frameLoaded)) && (
          <div className="absolute inset-0 grid place-items-center">
            <div className="flex flex-col items-center gap-3 text-sm text-muted-foreground">
              <Loader2 className="size-6 animate-spin text-sky-500" strokeWidth={1.75} />
              Подключение к Telegram…
            </div>
          </div>
        )}

        {session.status === "error" && (
          <div className="absolute inset-0 grid place-items-center p-6">
            <div className="flex max-w-sm flex-col items-center gap-3 text-center">
              <div className="grid size-11 place-items-center rounded-xl bg-destructive/10 text-destructive">
                <AlertTriangle className="size-5" strokeWidth={1.75} />
              </div>
              <p className="text-sm font-semibold text-foreground">Telegram недоступен</p>
              <p className="text-sm text-muted-foreground">{session.message}</p>
              <Button size="sm" onClick={() => void connect()}>
                <RotateCw strokeWidth={1.75} />
                Повторить
              </Button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
