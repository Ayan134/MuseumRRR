import { useState, useEffect, useRef, useCallback } from "react";
import { Link, useRouterState, useRouter } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LayoutDashboard, BarChart3, Archive, Wrench, LogOut, User, ShieldCheck, Menu, Bell, ClipboardList, Sparkles, Hash, Radar, KanbanSquare, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { getMeApi, getInitials, removeToken, getToken } from "@/lib/auth";
import { hasSection } from "@/lib/permissions";
import { closeTelegramSession, TELEGRAM_PERMISSION } from "@/lib/telegram";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { fetchUnreadCount, fetchNotifications, markAllNotificationsRead, markNotificationRead, type Notification } from "@/lib/tickets";
import { ThemeToggle } from "@/components/theme-toggle";

async function fetchProfileAvatar(): Promise<{ avatar_url: string | null; first_name: string | null; last_name: string | null }> {
  const token = getToken();
  const res = await fetch("/api/profile", { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) return { avatar_url: null, first_name: null, last_name: null };
  return res.json();
}

type NavItem = {
  label: string;
  to: string;
  icon: typeof LayoutDashboard;
};

const BASE_ITEMS: NavItem[] = [];

const Logo = () => (
  <svg viewBox="0 0 100 100" width="32" height="32" xmlns="http://www.w3.org/2000/svg">
    <path d="M34,15 L66,15 Q70,15 72,18.5 L88,46.5 Q90,50 88,53.5 L72,81.5 Q70,85 66,85 L34,85 Q30,85 28,81.5 L12,53.5 Q10,50 12,46.5 L28,18.5 Q30,15 34,15 Z" fill="#0d1b2a"/>
    <g stroke="white" strokeWidth="4" strokeLinecap="round">
      <line x1="50" y1="50" x2="50" y2="19"/>
      <line x1="50" y1="50" x2="77" y2="34"/>
      <line x1="50" y1="50" x2="77" y2="66"/>
      <line x1="50" y1="50" x2="50" y2="81"/>
      <line x1="50" y1="50" x2="23" y2="66"/>
      <line x1="50" y1="50" x2="23" y2="34"/>
    </g>
  </svg>
);

function NavContent({
  items,
  pathname,
  profileData,
  displayName,
  initials,
  onLogout,
  onNavigate,
}: {
  items: NavItem[];
  pathname: string;
  profileData: { avatar_url: string | null; first_name: string | null; last_name: string | null } | undefined;
  displayName: string;
  initials: string;
  onLogout: () => void;
  onNavigate?: () => void;
}) {
  return (
    <div className="flex h-full flex-col">
      {/* Logo */}
      <div className="px-6 pt-6 pb-4">
        <div className="flex items-center gap-2">
          <Logo />
          <span className="text-lg font-bold tracking-tight text-foreground">Meridian</span>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 space-y-1 px-3 pt-2">
        {items.map((item) => {
          const active = pathname === item.to;
          const Icon = item.icon;
          return (
            <Link key={item.label} to={item.to} className="block" onClick={onNavigate}>
              <span
                className={cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  active ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                )}
              >
                <Icon className="size-4 shrink-0" strokeWidth={1.75} />
                <span className="flex-1">{item.label}</span>
              </span>
            </Link>
          );
        })}
      </nav>

      {/* Profile pinned bottom */}
      <div className="border-t border-border p-3 space-y-1">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <NotificationBell onNavigate={onNavigate} />
          </div>
          <ThemeToggle />
        </div>
        <Link
          to="/profile"
          onClick={onNavigate}
          className={cn(
            "flex items-center gap-3 rounded-lg p-2 transition-colors hover:bg-secondary",
            pathname === "/profile" && "bg-accent text-accent-foreground",
          )}
        >
          <div className="relative shrink-0">
            {profileData?.avatar_url ? (
              <img
                src={profileData.avatar_url}
                alt="Аватар"
                className="size-10 rounded-full object-cover ring-1 ring-inset ring-black/5"
              />
            ) : (
              <div className="grid size-10 place-items-center rounded-full bg-gradient-to-br from-primary/80 to-primary text-sm font-semibold text-primary-foreground ring-1 ring-inset ring-black/5">
                {initials}
              </div>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-foreground">{displayName}</p>
            <p className="truncate text-xs text-muted-foreground">Мой профиль</p>
          </div>
          <User className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
        </Link>

        <button
          type="button"
          onClick={onLogout}
          className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <LogOut className="size-4 shrink-0" strokeWidth={1.75} />
          Выйти
        </button>
      </div>
    </div>
  );
}

function parseNotification(message: string) {
  const newMatch = message.match(/^Новая заявка назначена на вас:\s*\[(\w+)\]\s*(\S+)\s*—\s*(.+)$/);
  if (newMatch) return { emoji: "📋", headline: "Назначена новая заявка", source: newMatch[1], ticketId: newMatch[2], ticketTitle: newMatch[3].trim() };
  const reassignMatch = message.match(/^Заявка переназначена на вас:\s*\[(\w+)\]\s*(\S+)\s*—\s*(.+)$/);
  if (reassignMatch) return { emoji: "🔄", headline: "Заявка переназначена", source: reassignMatch[1], ticketId: reassignMatch[2], ticketTitle: reassignMatch[3].trim() };
  return { emoji: "🔔", headline: message, source: null, ticketId: null, ticketTitle: null };
}

export function NotificationItem({
  n,
  onRead,
  onOpenLink,
}: {
  n: Notification;
  onRead: (id: number) => void;
  /** Есть ссылка (напр. трекер задач "Задачи") — клик переходит и закрывает список. */
  onOpenLink?: (link: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (n.is_read || !ref.current) return;
    let timer: ReturnType<typeof setTimeout>;
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          timer = setTimeout(() => onRead(n.id), 1500);
        } else {
          clearTimeout(timer);
        }
      },
      { threshold: 0.8 },
    );
    obs.observe(ref.current);
    return () => { obs.disconnect(); clearTimeout(timer); };
  }, [n.id, n.is_read, onRead]);

  const p = parseNotification(n.message);
  const date = new Date(n.created_at + "Z").toLocaleString("ru-RU", {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });

  const clickable = !!n.link && !!onOpenLink;
  const openLink = () => {
    if (!clickable) return;
    if (!n.is_read) onRead(n.id);
    onOpenLink!(n.link!);
  };

  return (
    <div
      ref={ref}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? openLink : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openLink(); } } : undefined}
      data-testid="notification-item"
      className={cn(
        "relative mx-2 my-1 flex gap-3 rounded-xl px-3 py-3 transition-colors",
        clickable && "cursor-pointer",
        !n.is_read
          ? "border border-primary/20 bg-primary/[0.05] shadow-sm"
          : "border border-border/60 bg-card hover:bg-muted/40",
      )}
    >
      {!n.is_read && (
        <span className="absolute left-1 top-[17px] size-1.5 rounded-full bg-primary" />
      )}
      <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl bg-muted/80 text-base leading-none select-none">
        {p.emoji}
      </div>
      <div className="min-w-0 flex-1">
        <p className={cn("text-sm leading-tight break-words", !n.is_read ? "font-semibold text-foreground" : "font-medium text-foreground/75")}>
          {p.headline}
        </p>
        {p.source && p.ticketId && (
          <div className="mt-1 flex items-center gap-1.5">
            <span className={cn(
              "rounded-md px-1.5 py-0.5 text-[10px] font-bold tracking-wide",
              p.source === "Q19" ? "bg-blue-400/15 text-blue-600" : "bg-violet-400/15 text-violet-600",
            )}>
              {p.source}
            </span>
            <span className="font-mono text-xs text-foreground/60">{p.ticketId}</span>
          </div>
        )}
        {p.ticketTitle && (
          <p className="mt-0.5 truncate text-xs text-muted-foreground/80">{p.ticketTitle}</p>
        )}
        <p className="mt-1.5 text-[11px] text-muted-foreground/50">{date}</p>
      </div>
    </div>
  );
}

function MobileBellButton() {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const router = useRouter();

  const { data: count = 0 } = useQuery({
    queryKey: ["notifications-unread"],
    queryFn: fetchUnreadCount,
    refetchInterval: 30_000,
    retry: false,
  });

  const { data: notifications = [] } = useQuery<Notification[]>({
    queryKey: ["notifications-list"],
    queryFn: fetchNotifications,
    enabled: open,
    retry: false,
  });

  async function handleMarkAll() {
    await markAllNotificationsRead();
    qc.invalidateQueries({ queryKey: ["notifications-unread"] });
    qc.invalidateQueries({ queryKey: ["notifications-list"] });
  }

  const handleRead = useCallback(async (id: number) => {
    await markNotificationRead(id);
    qc.invalidateQueries({ queryKey: ["notifications-unread"] });
    qc.setQueryData<Notification[]>(["notifications-list"], (prev) =>
      prev?.map((n) => (n.id === id ? { ...n, is_read: true } : n)),
    );
  }, [qc]);

  const openLink = useCallback((link: string) => {
    setOpen(false);
    void router.navigate({ to: link } as never);
  }, [router]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="ml-auto relative grid size-9 place-items-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
        aria-label="Уведомления"
      >
        <Bell className="size-5" strokeWidth={1.75} />
        {count > 0 && (
          <span className="absolute top-1 right-1 flex size-4 items-center justify-center rounded-full bg-primary text-[9px] font-bold text-primary-foreground">
            {count > 9 ? "9+" : count}
          </span>
        )}
      </button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-80 flex flex-col p-0">
          <SheetHeader className="border-b border-border/50 px-4 py-3.5">
            <div className="flex items-center gap-2 pr-7">
              <SheetTitle className="flex-1 text-base">Уведомления</SheetTitle>
              {count > 0 && (
                <button
                  type="button"
                  onClick={handleMarkAll}
                  className="shrink-0 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  Прочитать все
                </button>
              )}
            </div>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto py-1.5">
            {notifications.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-14 text-sm text-muted-foreground">
                <Bell className="size-8 opacity-20" strokeWidth={1.25} />
                Нет уведомлений
              </div>
            ) : (
              notifications.map((n) => (
                <NotificationItem key={n.id} n={n} onRead={handleRead} onOpenLink={openLink} />
              ))
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

function NotificationBell({ onNavigate: _onNavigate }: { onNavigate?: () => void }) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const router = useRouter();

  const { data: count = 0 } = useQuery({
    queryKey: ["notifications-unread"],
    queryFn: fetchUnreadCount,
    refetchInterval: 30_000,
    retry: false,
  });

  const { data: notifications = [] } = useQuery<Notification[]>({
    queryKey: ["notifications-list"],
    queryFn: fetchNotifications,
    enabled: open,
    retry: false,
  });

  async function handleMarkAll() {
    await markAllNotificationsRead();
    qc.invalidateQueries({ queryKey: ["notifications-unread"] });
    qc.invalidateQueries({ queryKey: ["notifications-list"] });
  }

  const handleRead = useCallback(async (id: number) => {
    await markNotificationRead(id);
    qc.invalidateQueries({ queryKey: ["notifications-unread"] });
    qc.setQueryData<Notification[]>(["notifications-list"], (prev) =>
      prev?.map((n) => (n.id === id ? { ...n, is_read: true } : n)),
    );
  }, [qc]);

  const openLink = useCallback((link: string) => {
    setOpen(false);
    void router.navigate({ to: link } as never);
  }, [router]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="relative flex w-full items-center gap-3 rounded-lg px-2 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
      >
        <Bell className="size-4 shrink-0" strokeWidth={1.75} />
        Уведомления
        {count > 0 && (
          <span className="ml-auto flex size-5 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">
            {count > 99 ? "99+" : count}
          </span>
        )}
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-80 sm:w-96 flex flex-col p-0">
          <SheetHeader className="border-b border-border/50 px-4 py-3.5">
            <div className="flex items-center gap-2 pr-7">
              <SheetTitle className="flex-1 text-base">Уведомления</SheetTitle>
              {count > 0 && (
                <button
                  type="button"
                  onClick={handleMarkAll}
                  className="shrink-0 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  Прочитать все
                </button>
              )}
            </div>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto py-1.5">
            {notifications.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-14 text-sm text-muted-foreground">
                <Bell className="size-8 opacity-20" strokeWidth={1.25} />
                Нет уведомлений
              </div>
            ) : (
              notifications.map((n) => (
                <NotificationItem key={n.id} n={n} onRead={handleRead} onOpenLink={openLink} />
              ))
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

export function AppSidebar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const router = useRouter();
  const qc = useQueryClient();
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  const { data: user } = useQuery({
    queryKey: ["me"],
    queryFn: getMeApi,
    staleTime: 10 * 60 * 1000,
    retry: false,
  });

  // "Администратор" (пункт меню /admin) пока нет отдельного permission-ключа в
  // каталоге feature_permissions (доработка "расширяем систему прав доступа",
  // 2026-09-10 — см. брифинг фронтенд-агента, п.1: "если по факту такого ключа
  // не оказалось — используй временно role in (...)"). project_manager видит
  // "Администратор" ради вкладки "Алиасы сотрудников" (сервер скопирует его на
  // свой project_key), coordinator — ради "Пользователи"/"Репозиторий кодов"
  // (сервер скопирует на его модули, с 15.09 их может быть 1+). Сами под-панели
  // внутри /admin гейтятся
  // каждая отдельно (см. admin.tsx), это только видимость пункта меню.
  const canSeeAdminSection =
    user?.role === "admin" || user?.role === "owner" ||
    user?.role === "project_manager" || user?.role === "coordinator";
  const permissions = user?.permissions ?? [];
  // Эффективные права из /me уже полностью развёрнуты сервером (admin/owner получают
  // весь каталог ключей) — отдельный isAdmin-спецкейс здесь больше не нужен.
  const hasDashboard = hasSection(permissions, "dashboard");
  const hasMyTickets = hasSection(permissions, "my_tickets");
  const hasAnalytics = hasSection(permissions, "analytics");
  const hasCodeRepository = hasSection(permissions, "code_repository");
  // Свой permission-ключ "situation_center" (25.09.2026, миграция 0800060a003a) — разведён с
  // "analytics": видят admin/owner (весь каталог) и coordinator (дефолт роли, свои модули).
  const hasSituationCenter = hasSection(permissions, "situation_center");
  const hasReports = hasSection(permissions, "reports");
  const hasTools = hasSection(permissions, "tools");
  const hasArm = hasSection(permissions, "arm");
  // Трекер задач «Задачи» (docs/proposals/tracker.md) — раздел виден всем (право
  // "tracker" is_public в feature_permissions), доступ к конкретной доске — живые
  // гранты внутри самого модуля (см. src/tracker/), не на уровне этого пункта меню.
  const hasTracker = hasSection(permissions, "tracker");
  // «Telegram» — Telegram Web K во вкладке (backend/app/routers/telegram.py), право
  // "telegram" (не публичное: admin/owner — автоматически, остальным выдаётся в админке).
  const hasTelegram = permissions.includes(TELEGRAM_PERMISSION);

  const items: NavItem[] = [
    ...BASE_ITEMS,
    // "Дашборд"/"Мои заявки" раньше сидели в безусловном BASE_ITEMS без проверки
    // прав вообще — узкие линии 1/3 (миграция b1c2d3e4f5a6) видели их в навбаре,
    // хотя бэкенд уже не давал эти ключи. Найдено при ручном QA 2026-09-11.
    ...(hasDashboard ? [{ label: "Дашборд", to: "/" as const, icon: LayoutDashboard }] : []),
    ...(hasMyTickets ? [{ label: "Мои заявки", to: "/my-tickets" as const, icon: ClipboardList }] : []),
    ...(hasAnalytics ? [{ label: "Аналитика", to: "/analytics" as const, icon: BarChart3 }] : []),
    // "Ситуационный центр" (Фаза D, docs/proposals/situation_center.md) — раньше
    // был вкладкой внутри "Аналитики", теперь свой роут/пункт меню. Тот же
    // permission-ключ "analytics" (не заводим новый — доступ не менялся, только
    // расположение), ISNA-only ограничение решает бэкенд.
    ...(hasSituationCenter ? [{ label: "Ситуационный центр", to: "/situation-center" as const, icon: Radar }] : []),
    // "Репозиторий заявок" (аналитика по кодам закрытия, Фаза 1 — см.
    // docs/proposals/tz_codes_analytics.md) — отдельный пункт, НЕ вкладка внутри
    // "Аналитика" (явное решение Ансара). Свой permission-ключ "code_repository"
    // (миграция d6e7f8a9b0c1, доработка "расширяем систему прав доступа") —
    // разъединён с "analytics" 2026-09-10, см. routes/_auth/code-repository.tsx.
    ...(hasCodeRepository ? [{ label: "Репозиторий заявок", to: "/code-repository" as const, icon: Hash }] : []),
    // Хранилище — тоже было безусловным ("открыто всем авторизованным"), решение
    // предшествовало концепции узких линий. Теперь гейтится ключом "reports"
    // (существовал в каталоге и раньше, просто нигде не использовался) — доступ к
    // конкретным папкам внутри по-прежнему решает отдельный ACL на бэкенде.
    ...(hasReports ? [{ label: "Хранилище", to: "/reports" as const, icon: Archive }] : []),
    // «Задачи» — трекер (docs/proposals/tracker.md), право "tracker" is_public — виден
    // всем авторизованным; доступ к конкретной доске выдаётся отдельно живыми грантами.
    ...(hasTracker ? [{ label: "Задачи", to: "/tracker" as const, icon: KanbanSquare }] : []),
    ...(hasTelegram ? [{ label: "Telegram", to: "/telegram" as const, icon: Send }] : []),
    ...(hasTools ? [{ label: "Инструменты", to: "/tools" as const, icon: Wrench }] : []),
    ...(canSeeAdminSection ? [{ label: "Администратор", to: "/admin" as const, icon: ShieldCheck }] : []),
    // АРМ Сотрудника — хаб (демо-витрина ИИ-разбора без бэкенда + "Регистрационные
    // данные", рабочий инструмент поверх живого РМССП-бэкенда, + "Единое окно" в
    // разработке). Опционален по выдаче через админку (permission "arm"/"arm.*") —
    // hasSection пускает и тех, кому выдан только один из под-элементов.
    ...(hasArm ? [{ label: "АРМ Сотрудника", to: "/arm" as const, icon: Sparkles }] : []),
  ];

  const { data: profileData } = useQuery({
    queryKey: ["profile"],
    queryFn: fetchProfileAvatar,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  async function handleLogout() {
    // До removeToken: стирает куку Telegram и хранилище сайта (сессию TG в IndexedDB).
    await closeTelegramSession();
    removeToken();
    qc.clear();
    void router.navigate({ to: "/login" });
  }

  const initials = user ? getInitials(user.email) : "..";
  const fullName = [profileData?.last_name, profileData?.first_name].filter(Boolean).join(" ");
  const displayName = fullName || (user ? user.email.split("@")[0] : "Загрузка...");

  const navProps = { items, pathname, profileData, displayName, initials, onLogout: handleLogout };

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden md:flex w-64 flex-col border-r border-border bg-sidebar">
        <NavContent {...navProps} />
      </aside>

      {/* Mobile top bar */}
      <div className="md:hidden fixed top-0 left-0 right-0 z-40 flex h-14 items-center border-b border-border bg-sidebar px-4 gap-3">
        <button
          type="button"
          onClick={() => setMobileOpen(true)}
          className="grid size-9 place-items-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
          aria-label="Открыть меню"
        >
          <Menu className="size-5" strokeWidth={1.75} />
        </button>
        <Logo />
        <span className="text-base font-bold tracking-tight text-foreground">Meridian</span>
        <MobileBellButton />
      </div>

      {/* Mobile drawer */}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-64 p-0 bg-sidebar border-r border-border">
          <NavContent {...navProps} onNavigate={() => setMobileOpen(false)} />
        </SheetContent>
      </Sheet>
    </>
  );
}
