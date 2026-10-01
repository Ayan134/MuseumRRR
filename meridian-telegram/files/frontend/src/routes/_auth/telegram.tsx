import { createFileRoute, redirect } from "@tanstack/react-router";
import { getMeApi } from "@/lib/auth";
import { TELEGRAM_PERMISSION } from "@/lib/telegram";

export const Route = createFileRoute("/_auth/telegram")({
  beforeLoad: async ({ context: { queryClient } }) => {
    const user = await queryClient.ensureQueryData({ queryKey: ["me"], queryFn: getMeApi });
    if (!user.permissions.includes(TELEGRAM_PERMISSION)) {
      throw redirect({ to: "/403" });
    }
  },
  // Пусто намеренно: сам раздел — TelegramPanel в _auth-layout (routes/_auth.tsx),
  // он переживает уход на другие страницы, чтобы iframe клиента не перезагружался.
  component: () => null,
});
