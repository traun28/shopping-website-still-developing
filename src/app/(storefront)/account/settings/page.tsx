import { redirect } from "next/navigation";
import { AccountShell } from "@/components/layouts/account-shell";
import { DeactivateAccountCard, ExportDataCard } from "@/components/account/settings-privacy";
import { loadAccountContext } from "@/server/account-context";

export default async function SettingsPage() {
  const context = await loadAccountContext();
  if (!context) redirect("/login");

  return (
    <AccountShell
      title="Privacy & settings"
      description="Your data and account lifecycle controls."
      active="settings"
      identity={context.identity}
      unreadNotifications={context.unreadNotifications}
    >
      <div className="max-w-2xl space-y-6">
        <ExportDataCard />
        <DeactivateAccountCard role={context.user.role} />
      </div>
    </AccountShell>
  );
}
