import { Activity, AlertTriangle, CheckCircle2, Clock3 } from "lucide-react";
import { AdminShell } from "@/components/layouts/admin-shell";
import { Badge } from "@/components/ui/badge";
import { StatCard } from "@/components/cards/stat-card";
import { getAdminCheckoutMetrics } from "@/services/checkout/checkout.service";

export const dynamic = "force-dynamic";

export default async function AdminCheckoutPage() {
  const metrics = await getAdminCheckoutMetrics();
  return (
    <AdminShell>
      <header className="mb-8">
        <Badge variant="warning">Preparation only · no payments or orders</Badge>
        <h1 className="mt-3 font-display text-3xl font-extrabold uppercase tracking-tight sm:text-4xl">Checkout monitoring</h1>
        <p className="mt-2 max-w-3xl text-sm text-smoke">
          Aggregate session health and blocking issue codes. This view intentionally excludes customer names, emails, phone numbers and address snapshots.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Sessions · 30 days" value={String(metrics.total30Days)} icon={Activity} hint="Bounded operational window" />
        <StatCard label="Active" value={String(metrics.active)} icon={Clock3} hint="Not terminal or expired" />
        <StatCard label="Ready" value={String(metrics.ready)} icon={CheckCircle2} hint="Not payment or order success" />
        <StatCard label="Needs attention" value={String(metrics.needsAttention)} icon={AlertTriangle} hint="One or more blockers" />
      </div>

      <div className="mt-8 grid gap-6 xl:grid-cols-2">
        <section className="rounded-card border-[1.5px] border-clay bg-cream p-5">
          <h2 className="font-display text-lg font-bold uppercase">Blocking issue codes</h2>
          <p className="mt-1 text-xs text-smoke">Counts are session-level and derived from the latest stored validation snapshot.</p>
          {metrics.blockingIssueCounts.length ? (
            <ul className="mt-4 divide-y divide-clay">
              {metrics.blockingIssueCounts.map((item) => (
                <li key={item.code} className="flex items-center justify-between gap-4 py-2 text-sm">
                  <span className="font-mono text-xs">{item.code}</span><span className="font-semibold">{item.count}</span>
                </li>
              ))}
            </ul>
          ) : <p className="mt-4 text-sm text-smoke">No stored blockers in the current sample.</p>}
          <p className="mt-4 rounded-xl border border-warning/40 bg-warning/10 p-3 text-xs text-smoke">Shipping and destination tax are currently not configured. Checkout must remain blocked until real services and quotes are integrated.</p>
        </section>

        <section className="rounded-card border-[1.5px] border-clay bg-cream p-5">
          <h2 className="font-display text-lg font-bold uppercase">Recent session changes</h2>
          <p className="mt-1 text-xs text-smoke">Session ids are shown only for internal support correlation; no personal snapshot fields are selected.</p>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[34rem] border-collapse text-left text-xs">
              <thead><tr className="border-b border-clay text-[10px] uppercase tracking-[0.12em] text-smoke"><th className="py-2 pr-3">Session</th><th className="py-2 pr-3">State</th><th className="py-2 pr-3">Version</th><th className="py-2 pr-3">Issue codes</th><th className="py-2">Updated</th></tr></thead>
              <tbody>
                {metrics.recentTransitions.map((row) => (
                  <tr key={row.id} className="border-b border-clay/60 align-top">
                    <td className="py-3 pr-3 font-mono">{row.id.slice(0, 8)}…</td>
                    <td className="py-3 pr-3"><Badge variant={row.status === "READY" ? "success" : row.status === "NEEDS_ATTENTION" ? "warning" : "soft"}>{row.status.replaceAll("_", " ")}</Badge></td>
                    <td className="py-3 pr-3">{row.version}</td>
                    <td className="max-w-48 py-3 pr-3 font-mono">{row.issueCodes.join(", ") || "—"}</td>
                    <td className="py-3">{row.updatedAt.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <p className="mt-6 text-xs text-smoke">Expired sessions retain only operational snapshots until the configured retention cleanup clears PII; session rows are retained for aggregate reporting.</p>
    </AdminShell>
  );
}
