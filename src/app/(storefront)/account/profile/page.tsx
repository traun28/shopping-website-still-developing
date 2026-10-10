import { redirect } from "next/navigation";
import { AccountShell } from "@/components/layouts/account-shell";
import { AvatarManager } from "@/components/account/avatar-manager";
import { EmailChangeCard } from "@/components/account/email-change-card";
import { ProfileForm } from "@/components/account/profile-form";
import { loadAccountContext } from "@/server/account-context";
import { getCustomerProfile } from "@/services/profile.service";
import { Badge } from "@/components/ui/badge";

export default async function ProfilePage() {
  const context = await loadAccountContext();
  if (!context) redirect("/login");

  const { user } = context;
  const profile = await getCustomerProfile(user.id);

  return (
    <AccountShell
      title="Profile"
      description="Your identity, photo and sign-in email."
      active="profile"
      identity={context.identity}
      unreadNotifications={context.unreadNotifications}
    >
      <div className="max-w-2xl space-y-6">
        <section className="rounded-card border-[1.5px] border-clay bg-cream p-5" aria-labelledby="profile-completeness-title">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 id="profile-completeness-title" className="font-display text-sm font-bold uppercase">Profile completeness</h2>
              <p className="mt-1 text-xs text-smoke">{profile.completeness.completed} of {profile.completeness.total} useful account details are complete.</p>
            </div>
            <Badge variant={profile.completeness.percent === 100 ? "success" : "warning"}>{profile.completeness.percent}%</Badge>
          </div>
          <div className="mt-4 h-2 overflow-hidden rounded-pill bg-sand" role="progressbar" aria-label="Profile completeness" aria-valuemin={0} aria-valuemax={100} aria-valuenow={profile.completeness.percent}>
            <div className="h-full rounded-pill bg-flame" style={{ width: `${profile.completeness.percent}%` }} />
          </div>
          {profile.completeness.missing.length ? (
            <ul className="mt-3 list-inside list-disc text-xs text-smoke">
              {profile.completeness.missing.map((item) => <li key={item}>{item}</li>)}
            </ul>
          ) : <p className="mt-3 text-xs text-success">Your profile has the basics needed for checkout.</p>}
        </section>
        <AvatarManager name={user.name} avatarUrl={user.avatarUrl} />
        <ProfileForm defaultName={user.name} defaultPhone={user.phone ?? ""} />
        <EmailChangeCard
          email={user.email}
          verified={Boolean(user.emailVerifiedAt)}
          pendingEmail={user.pendingEmail}
        />
      </div>
    </AccountShell>
  );
}
