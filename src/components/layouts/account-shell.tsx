import Image from "next/image";
import {
  Bell,
  Heart,
  KeyRound,
  LogOut,
  MapPin,
  Package,
  Settings,
  SlidersHorizontal,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { Container } from "@/components/ui/container";
import { Badge } from "@/components/ui/badge";
import { logoutAction } from "@/server/actions/auth-actions";
import { cn } from "@/lib/utils";

/**
 * Account layout — identity card + navigation + content pane.
 * Mobile: horizontal scrollable chip nav (44px touch targets, no overlap).
 * Desktop: sticky sidebar.
 */

export const accountNav: { label: string; href: string; icon: LucideIcon; key: string }[] = [
  { key: "overview", label: "Overview", href: "/account", icon: UserRound },
  { key: "profile", label: "Profile", href: "/account/profile", icon: UserRound },
  { key: "orders", label: "Orders", href: "/account/orders", icon: Package },
  { key: "wishlist", label: "Wishlist", href: "/account/wishlist", icon: Heart },
  { key: "addresses", label: "Addresses", href: "/account/addresses", icon: MapPin },
  { key: "notifications", label: "Notifications", href: "/account/notifications", icon: Bell },
  { key: "security", label: "Security", href: "/account/security", icon: KeyRound },
  { key: "preferences", label: "Preferences", href: "/account/preferences", icon: SlidersHorizontal },
  { key: "settings", label: "Privacy & settings", href: "/account/settings", icon: Settings },
];

export interface AccountIdentity {
  name: string;
  email: string;
  avatarUrl: string | null;
}

export function AccountShell({
  children,
  title,
  description,
  active,
  identity,
  unreadNotifications = 0,
}: {
  children: ReactNode;
  title: string;
  description?: string;
  active: string;
  identity: AccountIdentity;
  unreadNotifications?: number;
}) {
  const initials = identity.name
    .split(" ")
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <Container className="py-8 md:py-14">
      {/* Identity card */}
      <div className="mb-8 flex items-center gap-4 rounded-card border-[1.5px] border-ink bg-cream p-5 shadow-hard-sm">
        <span className="relative flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-pill border-[1.5px] border-ink bg-flame">
          {identity.avatarUrl ? (
            <Image src={identity.avatarUrl} alt="" fill sizes="56px" className="object-cover" />
          ) : (
            <span aria-hidden className="font-display text-lg font-extrabold text-on-accent">
              {initials}
            </span>
          )}
        </span>
        <div className="min-w-0">
          <h1 className="truncate font-display text-xl font-extrabold uppercase tracking-tight sm:text-2xl">
            {title}
          </h1>
          <p className="truncate text-xs text-smoke">
            {identity.name} · {identity.email}
          </p>
        </div>
        {description ? (
          <p className="ml-auto hidden max-w-xs text-right text-xs text-smoke md:block">{description}</p>
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[15rem_1fr]">
        {/* Navigation */}
        <div className="lg:border-r lg:border-clay lg:pr-6">
          <nav aria-label="Account navigation">
            <ul className="-mx-5 flex gap-1.5 overflow-x-auto px-5 pb-2 lg:mx-0 lg:flex-col lg:gap-1 lg:overflow-visible lg:px-0 lg:pb-0">
              {accountNav.map(({ label, href, icon: Icon, key }) => {
                const isActive = active === key;
                const showBadge = key === "notifications" && unreadNotifications > 0;
                return (
                  <li key={key} className="shrink-0">
                    <a
                      href={href}
                      aria-current={isActive ? "page" : undefined}
                      className={cn(
                        "relative flex items-center gap-2.5 rounded-pill px-4 py-3 text-sm font-medium transition-colors lg:rounded-card lg:py-2.5",
                        isActive ? "bg-ink text-paper" : "bg-cream text-ink/75 hover:bg-sand lg:bg-transparent",
                      )}
                    >
                      <Icon className="size-4" aria-hidden />
                      {label}
                      {showBadge ? (
                        <Badge variant="new" className="px-1.5 py-0 text-[9px]">
                          {unreadNotifications > 99 ? "99+" : unreadNotifications}
                        </Badge>
                      ) : null}
                    </a>
                  </li>
                );
              })}
              <li className="shrink-0">
                <form action={logoutAction}>
                  <button
                    type="submit"
                    className="flex w-full items-center gap-2.5 rounded-pill px-4 py-3 text-left text-sm font-medium text-smoke transition-colors hover:bg-danger/10 hover:text-danger lg:rounded-card lg:py-2.5"
                  >
                    <LogOut className="size-4" aria-hidden />
                    Sign out
                  </button>
                </form>
              </li>
            </ul>
          </nav>
        </div>

        <div className="min-w-0">{children}</div>
      </div>
    </Container>
  );
}
