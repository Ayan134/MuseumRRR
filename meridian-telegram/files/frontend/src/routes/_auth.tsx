import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { AppSidebar } from "@/components/app-sidebar";
import { ChangePasswordModal } from "@/components/change-password-modal";
import { TelegramPanel } from "@/components/telegram/telegram-panel";
import { getToken, useMe } from "@/lib/auth";

export const Route = createFileRoute("/_auth")({
  beforeLoad: () => {
    if (!getToken()) {
      throw redirect({ to: "/login" });
    }
  },
  component: AuthLayout,
});

function AuthLayout() {
  const { data: me } = useMe();
  const queryClient = useQueryClient();
  const mustChangePassword = me?.must_change_password ?? false;

  return (
    <div className="min-h-screen bg-background font-sans text-foreground antialiased">
      {/* Пока не сменит временный пароль после админского сброса — весь остальной
          интерфейс скрыт, видна только модалка (см. users.must_change_password,
          routers/admin.py::reset_password). Это UI-гейт, не серверная блокировка
          остальных эндпоинтов — сознательный выбор объёма фичи. */}
      <div className={mustChangePassword ? "hidden" : undefined}>
        <AppSidebar />
        <main className="pt-14 md:pt-0 md:pl-64">
          <Outlet />
          <TelegramPanel />
        </main>
      </div>

      {mustChangePassword && (
        <ChangePasswordModal
          open
          onOpenChange={() => {}}
          forced
          onSuccess={() => void queryClient.invalidateQueries({ queryKey: ["me"] })}
        />
      )}
    </div>
  );
}
