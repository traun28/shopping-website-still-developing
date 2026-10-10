import type { ReactNode } from "react";
import Link from "next/link";
import { Logo } from "@/components/brand/logo";
import {
  BarChart3,
  Boxes,
  FolderOpen,
  Layers,
  Paintbrush,
  Package,
  Percent,
  Search,
  Settings,
  Sparkles,
  ShoppingCart,
  Tags,
  Users,
  type LucideIcon,
} from "lucide-react";

/**
 * Admin layout shell — dark sidebar + content frame for the back-office
 * surface. Menu structure mirrors the modules of the admin milestone; items
 * without an href are disabled placeholders until the route exists.
 */

const adminNav: { section: string; items: { label: string; icon: LucideIcon; href?: string }[] }[] = [
  {
    section: "Operations",
    items: [
      { label: "Orders", icon: ShoppingCart },
      { label: "Checkout", href: "/admin/checkout", icon: ShoppingCart },
      { label: "Products", href: "/admin/products", icon: Package },
      { label: "Categories", href: "/admin/categories", icon: FolderOpen },
      { label: "Brands", href: "/admin/brands", icon: Tags },
      { label: "Inventory", href: "/admin/inventory", icon: Boxes },
      { label: "Collections", href: "/admin/collections", icon: Layers },
      { label: "Designs", icon: Paintbrush },
    ],
  },
  {
    section: "Growth",
    items: [
      { label: "Search", href: "/admin/search", icon: Search },
      { label: "Recommendations", href: "/admin/recommendations", icon: Sparkles },
      { label: "Customers", icon: Users },
      { label: "Promotions", href: "/admin/promotions", icon: Percent },
      { label: "Analytics", icon: BarChart3 },
    ],
  },
  {
    section: "System",
    items: [{ label: "Settings", icon: Settings }],
  },
];

export function AdminShell({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-svh grid-cols-1 bg-paper lg:grid-cols-[16rem_1fr]">
      <aside className="border-b-[1.5px] border-paper/15 bg-ink text-paper lg:border-b-0 lg:border-r-[1.5px]">
        <div className="border-b border-paper/15 p-5">
          <Logo />
          <p className="mt-1.5 font-mono text-[9px] uppercase tracking-[0.2em] text-paper/50">
            Admin console
          </p>
        </div>
        <nav aria-label="Admin" className="space-y-6 p-5">
          {adminNav.map((group) => (
            <div key={group.section}>
              <p className="font-mono text-[9px] uppercase tracking-[0.22em] text-paper/40">
                {group.section}
              </p>
              <ul className="mt-2 space-y-0.5">
                {group.items.map(({ label, icon: Icon, href }) => (
                  <li key={label}>
                    {href ? (
                      <Link href={href} className="flex items-center gap-2.5 rounded-card px-3 py-2 text-sm text-paper hover:bg-paper/10">
                        <Icon className="size-4" aria-hidden />
                        {label}
                      </Link>
                    ) : (
                      <span
                        aria-disabled="true"
                        title="Not part of catalog management"
                        className="flex cursor-not-allowed items-center gap-2.5 rounded-card px-3 py-2 text-sm text-paper/50"
                      >
                        <Icon className="size-4" aria-hidden />
                        {label}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </aside>
      <div className="min-w-0 p-6 md:p-10">{children}</div>
    </div>
  );
}
