import { useQuery } from "@tanstack/react-query";

const TOKEN_KEY = "isnaverse_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function removeToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

// Единый источник истины для авторизованных заголовков — используется во всех lib/*
// (api.ts, tickets.ts, projects.ts), не дублировать.
export function authHeaders(): Record<string, string> {
  const token = getToken();
  const base: Record<string, string> = { "Content-Type": "application/json" };
  if (token) base["Authorization"] = `Bearer ${token}`;
  return base;
}

export interface CurrentUser {
  id: number;
  email: string;
  is_active: boolean;
  role: string;
  permissions: string[];
  project_key: string | null;
  must_change_password: boolean;
  modules: string[];
}

export async function loginApi(email: string, password: string): Promise<string> {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    if (res.status === 422) throw new Error("Проверьте правильность введённых данных");
    const err = await res.json().catch(() => ({})) as { detail?: unknown };
    const detail = err.detail;
    throw new Error(typeof detail === "string" ? detail : "Ошибка авторизации");
  }
  const data = await res.json() as { access_token: string };
  return data.access_token;
}

export async function getMeApi(): Promise<CurrentUser> {
  const token = getToken();
  const res = await fetch("/api/auth/me", {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error("Unauthorized");
  return res.json() as Promise<CurrentUser>;
}

export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: getMeApi,
    staleTime: 10 * 60 * 1000,
  });
}

// Нет единого api-клиента — все запросы через голый fetch, поэтому патчим его глобально.
export function installAuthInterceptor(
  router: { navigate: (opts: { to: string }) => unknown },
  queryClient: { clear: () => void },
): void {
  const originalFetch = window.fetch.bind(window);

  window.fetch = async (...args: Parameters<typeof fetch>) => {
    const res = await originalFetch(...args);
    if (res.status === 401) {
      const input = args[0];
      const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
      if (url.startsWith("/api/") && !url.startsWith("/api/auth/login") && getToken()) {
        // Сессия Meridian протухла — гасим и Telegram во вкладке (кука + Clear-Site-Data,
        // см. lib/telegram.ts::closeTelegramSession; не импортируем — цикл auth <-> telegram).
        void originalFetch("/api/tg/session", { method: "DELETE" }).catch(() => undefined);
        removeToken();
        queryClient.clear();
        void router.navigate({ to: "/login" });
      }
    }
    return res;
  };
}

export function getInitials(email: string): string {
  const name = email.split("@")[0];
  const parts = name.split(/[._-]/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}
