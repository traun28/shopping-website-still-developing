import { redirect } from "next/navigation";
import { AccountShell } from "@/components/layouts/account-shell";
import { PreferencesForm } from "@/components/account/preferences-form";
import { loadAccountContext } from "@/server/account-context";
import { getPreferences } from "@/services/preferences.service";

export default async function PreferencesPage() {
  const context = await loadAccountContext();
  if (!context) redirect("/login");
  const preferences = await getPreferences(context.user.id);

  return (
    <AccountShell
      title="Preferences"
      description="Choose your communication, language and measurement preferences."
      active="preferences"
      identity={context.identity}
      unreadNotifications={context.unreadNotifications}
    >
      <div className="max-w-3xl space-y-4">
        <p className="text-sm text-smoke">
          Order and account notices remain separate from optional marketing messages. Your communication choices can be changed here at any time.
        </p>
        <PreferencesForm initial={preferences} />
      </div>
    </AccountShell>
  );
}
