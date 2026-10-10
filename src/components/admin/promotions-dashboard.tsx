"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatPrice } from "@/lib/format";

export interface PromotionAdminRow {
  id: string;
  campaignId: string | null;
  campaignName: string | null;
  name: string;
  description: string | null;
  strategy: string;
  status: string;
  discountConfig: Record<string, unknown>;
  eligibility: Record<string, unknown>;
  priority: number;
  stackable: boolean;
  stackGroup: string | null;
  isAutomatic: boolean;
  applyToCatalog: boolean;
  currency: string;
  totalUsageLimit: number | null;
  perCustomerUsageLimit: number | null;
  startsAt: string | null;
  endsAt: string | null;
  timezone: string;
  version: number;
  couponCodes: Array<{ id: string; code: string; isActive: boolean }>;
  targets: Array<{ dimension: string; entityId: string; mode: string }>;
}

export interface CampaignAdminRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  status: string;
  version: number;
  promotionCount: number;
  startsAt: string | null;
  endsAt: string | null;
}

export interface PromotionAnalyticsRow {
  id: string;
  name: string;
  status: string;
  currency: string;
  reserved: number;
  redeemed: number;
  released: number;
  reservedDiscountPaise: number;
  redeemedFinalizationIntegrated: false;
}

interface PromotionForm {
  name: string;
  description: string;
  strategy: string;
  percent: string;
  amount: string;
  threshold: string;
  quantity: string;
  buyQuantity: string;
  getQuantity: string;
  distinctProducts: string;
  code: string;
  isAutomatic: boolean;
  stackable: boolean;
  priority: string;
  totalLimit: string;
  perCustomerLimit: string;
  currency: string;
  campaignId: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
}

const EMPTY_FORM: PromotionForm = {
  name: "",
  description: "",
  strategy: "PERCENTAGE_OFF",
  percent: "10",
  amount: "100.00",
  threshold: "500.00",
  quantity: "3",
  buyQuantity: "1",
  getQuantity: "1",
  distinctProducts: "2",
  code: "",
  isAutomatic: true,
  stackable: false,
  priority: "100",
  totalLimit: "",
  perCustomerLimit: "",
  currency: "INR",
  campaignId: "",
  startsAt: "",
  endsAt: "",
  timezone: "Asia/Kolkata",
};

const TARGET_DIMENSIONS = ["PRODUCT", "CATEGORY", "BRAND", "SELLER", "COLLECTION", "CUSTOMER"] as const;

type TargetRow = { dimension: typeof TARGET_DIMENSIONS[number]; entityId: string; mode: "INCLUDE" | "EXCLUDE" };

function parseRupees(value: string): number {
  const clean = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(clean)) throw new Error("Enter a non-negative amount with up to two decimals.");
  const [whole, fraction = ""] = clean.split(".");
  const result = Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
  if (!Number.isSafeInteger(result)) throw new Error("Amount is too large.");
  return result;
}

function parsePercent(value: string): number {
  const clean = value.trim();
  if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(clean)) throw new Error("Enter a percentage with up to two decimals.");
  const [whole, fraction = ""] = clean.split(".");
  const result = Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
  if (result < 1 || result > 10_000) throw new Error("Percent must be greater than zero and at most 100.");
  return result;
}

function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive whole number.`);
  return parsed;
}

function parsePriority(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 100_000) throw new Error("Priority must be a whole number from zero to 100000.");
  return parsed;
}

function dateToIso(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Schedule contains an invalid date.");
  return date.toISOString();
}

async function api<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json() as { ok?: boolean; data?: T; error?: { message?: string } };
  if (!response.ok || !payload.ok || payload.data === undefined) {
    throw new Error(payload.error?.message ?? `Request failed (${response.status}).`);
  }
  return payload.data;
}

function localDate(value: string | null): string {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  const local = new Date(parsed.getTime() - parsed.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function configDefaults(row: PromotionAdminRow, base: PromotionForm): PromotionForm {
  const config = row.discountConfig;
  const strategy = row.strategy;
  const next = { ...base, strategy, name: row.name, description: row.description ?? "", priority: String(row.priority), stackable: row.stackable, currency: row.currency, campaignId: row.campaignId ?? "", isAutomatic: row.isAutomatic, code: row.couponCodes[0]?.code ?? "", totalLimit: row.totalUsageLimit == null ? "" : String(row.totalUsageLimit), perCustomerLimit: row.perCustomerUsageLimit == null ? "" : String(row.perCustomerUsageLimit), startsAt: localDate(row.startsAt), endsAt: localDate(row.endsAt), timezone: row.timezone };
  if (strategy === "PERCENTAGE_OFF") next.percent = String(Number(config.discountBasisPoints ?? 0) / 100);
  if (strategy === "FIXED_AMOUNT_OFF") next.amount = (Number(config.amountPaise ?? 0) / 100).toFixed(2);
  if (strategy === "CART_THRESHOLD") {
    next.threshold = (Number(config.thresholdPaise ?? 0) / 100).toFixed(2);
    next.percent = String(Number(config.value ?? 0) / 100);
  }
  if (strategy === "QUANTITY_TIER") {
    const first = (config.tiers as Array<Record<string, unknown>> | undefined)?.[0];
    if (first) { next.quantity = String(first.minQuantity ?? 3); next.percent = String(Number(first.value ?? 0) / 100); }
  }
  if (strategy === "BUY_X_GET_Y") {
    next.buyQuantity = String(config.buyQuantity ?? 1);
    next.getQuantity = String(config.getQuantity ?? 1);
    next.percent = String(Number(config.rewardBasisPoints ?? 10_000) / 100);
  }
  if (strategy === "BUNDLE") {
    next.distinctProducts = String(config.minimumDistinctProducts ?? 2);
    next.percent = String(Number(config.discountBasisPoints ?? 1000) / 100);
  }
  return next;
}

export function PromotionsDashboard({ initialPromotions, initialCampaigns, initialAnalytics }: {
  initialPromotions: PromotionAdminRow[];
  initialCampaigns: CampaignAdminRow[];
  initialAnalytics: PromotionAnalyticsRow[];
}) {
  const router = useRouter();
  const [promotions, setPromotions] = useState(initialPromotions);
  const [campaigns, setCampaigns] = useState(initialCampaigns);
  const [analytics, setAnalytics] = useState(initialAnalytics);
  const [form, setForm] = useState(EMPTY_FORM);
  const [targets, setTargets] = useState<TargetRow[]>([]);
  const [targetDimension, setTargetDimension] = useState<TargetRow["dimension"]>("PRODUCT");
  const [targetMode, setTargetMode] = useState<TargetRow["mode"]>("INCLUDE");
  const [targetId, setTargetId] = useState("");
  const [editing, setEditing] = useState<PromotionAdminRow | null>(null);
  const [campaignName, setCampaignName] = useState("");
  const [campaignSlug, setCampaignSlug] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [simulation, setSimulation] = useState<Record<string, unknown> | null>(null);
  const [simPromotionId, setSimPromotionId] = useState("");
  const [simCode, setSimCode] = useState("");
  const [simProductId, setSimProductId] = useState("");
  const [simVariantId, setSimVariantId] = useState("");
  const [simQuantity, setSimQuantity] = useState("1");
  const [assumeActive, setAssumeActive] = useState(true);

  async function reload() {
    const [nextPromotions, nextCampaigns, nextAnalytics] = await Promise.all([
      api<PromotionAdminRow[]>("/api/admin/promotions"),
      api<CampaignAdminRow[]>("/api/admin/campaigns"),
      api<PromotionAnalyticsRow[]>("/api/admin/promotions/analytics"),
    ]);
    setPromotions(nextPromotions);
    setCampaigns(nextCampaigns);
    setAnalytics(nextAnalytics);
    router.refresh();
  }

  function updateForm<K extends keyof PromotionForm>(key: K, value: PromotionForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function addTarget() {
    const entityId = targetId.trim();
    if (!entityId) return;
    if (targets.some((target) => target.dimension === targetDimension && target.entityId === entityId && target.mode === targetMode)) {
      setError("That target is already in the rule list.");
      return;
    }
    setTargets((current) => [...current, { dimension: targetDimension, entityId, mode: targetMode }]);
    setTargetId("");
    setError(null);
  }

  function makePayload(expectedVersion?: number) {
    const strategy = form.strategy;
    const usesPercent = ["PERCENTAGE_OFF", "CART_THRESHOLD", "QUANTITY_TIER", "BUY_X_GET_Y", "BUNDLE"].includes(strategy);
    const percent = usesPercent ? parsePercent(form.percent) : 0;
    let config: Record<string, unknown>;
    if (strategy === "PERCENTAGE_OFF") config = { strategy, discountBasisPoints: percent };
    else if (strategy === "FIXED_AMOUNT_OFF") config = { strategy, amountPaise: parseRupees(form.amount) };
    else if (strategy === "CART_THRESHOLD") config = { strategy, thresholdPaise: parseRupees(form.threshold), discountType: "PERCENTAGE", value: percent };
    else if (strategy === "QUANTITY_TIER") config = { strategy, tiers: [{ minQuantity: parsePositiveInteger(form.quantity, "Tier quantity"), discountType: "PERCENTAGE", value: percent }] };
    else if (strategy === "BUY_X_GET_Y") config = { strategy, buyQuantity: parsePositiveInteger(form.buyQuantity, "Buy quantity"), getQuantity: parsePositiveInteger(form.getQuantity, "Reward quantity"), rewardBasisPoints: percent };
    else if (strategy === "BUNDLE") config = { strategy, minimumDistinctProducts: parsePositiveInteger(form.distinctProducts, "Distinct product count"), discountBasisPoints: percent };
    else config = { strategy: "FREE_SHIPPING" };
    const payload: Record<string, unknown> = {
      name: form.name,
      description: form.description || null,
      strategy,
      config,
      eligibility: { requireAuthenticatedCustomer: false },
      targets,
      couponCode: form.isAutomatic ? null : form.code,
      isAutomatic: form.isAutomatic,
      applyToCatalog: false,
      stackable: form.stackable,
      priority: parsePriority(form.priority || "100"),
      currency: form.currency,
      totalUsageLimit: form.totalLimit ? parsePositiveInteger(form.totalLimit, "Total usage limit") : null,
      perCustomerUsageLimit: form.perCustomerLimit ? parsePositiveInteger(form.perCustomerLimit, "Per-customer limit") : null,
      startsAt: dateToIso(form.startsAt),
      endsAt: dateToIso(form.endsAt),
      timezone: form.timezone,
      campaignId: form.campaignId || null,
    };
    if (expectedVersion !== undefined) payload.expectedVersion = expectedVersion;
    return payload;
  }

  async function submitPromotion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true); setError(null); setMessage(null);
    try {
      const payload = makePayload(editing?.version);
      const saved = await api<PromotionAdminRow>(editing ? `/api/admin/promotions/${editing.id}` : "/api/admin/promotions", editing ? "PATCH" : "POST", payload);
      setMessage(editing ? "Promotion saved as a new audited version." : "Promotion created in Draft state.");
      setEditing(null); setForm(EMPTY_FORM); setTargets([]);
      if (!editing && saved.id) setSimPromotionId(saved.id);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Promotion could not be saved.");
    } finally { setPending(false); }
  }

  function editPromotion(row: PromotionAdminRow) {
    setEditing(row);
    setForm(configDefaults(row, EMPTY_FORM));
    setTargets(row.targets.map((target) => ({ dimension: target.dimension as TargetRow["dimension"], entityId: target.entityId, mode: target.mode as TargetRow["mode"] })));
    setError(null); setMessage(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function transitionPromotion(row: PromotionAdminRow, action: "ACTIVATE" | "PAUSE" | "ARCHIVE") {
    setPending(true); setError(null); setMessage(null);
    try {
      await api(`/api/admin/promotions/${row.id}/state`, "POST", { expectedVersion: row.version, action });
      setMessage(`Promotion ${action.toLowerCase()} request saved.`);
      await reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Promotion state could not be changed."); }
    finally { setPending(false); }
  }

  async function createCampaign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setError(null); setMessage(null);
    try {
      await api("/api/admin/campaigns", "POST", { name: campaignName, slug: campaignSlug, timezone: form.timezone, startsAt: null, endsAt: null });
      setCampaignName(""); setCampaignSlug(""); setMessage("Campaign created in Draft state."); await reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Campaign could not be created."); }
    finally { setPending(false); }
  }

  async function transitionCampaign(row: CampaignAdminRow, action: "ACTIVATE" | "PAUSE" | "ARCHIVE") {
    setPending(true); setError(null); setMessage(null);
    try {
      await api(`/api/admin/campaigns/${row.id}/state`, "POST", { expectedVersion: row.version, action });
      setMessage(`Campaign ${action.toLowerCase()} request saved.`); await reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Campaign state could not be changed."); }
    finally { setPending(false); }
  }

  async function runSimulation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setError(null); setSimulation(null);
    try {
      const data = await api<Record<string, unknown>>("/api/admin/promotions/simulate", "POST", {
        ...(simPromotionId ? { promotionId: simPromotionId } : {}),
        couponCode: simCode || null,
        items: [{ productId: simProductId, variantId: simVariantId, quantity: parsePositiveInteger(simQuantity, "Quantity") }],
        assumeActive,
      });
      setSimulation(data);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Simulation failed."); }
    finally { setPending(false); }
  }

  const inputClass = "w-full rounded-full border border-clay bg-white/60 px-4 py-2 text-sm";

  return (
    <div className="space-y-8">
      <header>
        <div className="flex flex-wrap items-center gap-2"><Badge variant="warning">Checkout/campaign rules · no order redemption</Badge><Badge variant="soft">Integer-paise allocation</Badge></div>
        <h1 className="mt-3 font-display text-3xl font-extrabold uppercase">Promotions</h1>
        <p className="mt-2 max-w-4xl text-sm text-smoke">Configure campaigns, coupon rules, normalized catalog/customer targets, schedules, stacking and limits. Preview uses current server catalog prices and never reserves capacity. Configuration changes are versioned and written to the transactional outbox.</p>
      </header>

      {error ? <p role="alert" className="rounded-xl border border-danger/40 bg-danger/10 p-3 text-sm text-danger">{error}</p> : null}
      {message ? <p role="status" className="rounded-xl border border-success/40 bg-success/10 p-3 text-sm text-success">{message}</p> : null}

      <section className="rounded-card border-[1.5px] border-clay bg-cream p-5 sm:p-7">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div><p className="font-mono text-[10px] uppercase tracking-[0.18em] text-smoke">Rule builder</p><h2 className="mt-1 font-display text-xl font-bold uppercase">{editing ? `Edit · ${editing.name}` : "Create promotion"}</h2></div>
          {editing ? <Button type="button" variant="outline" onClick={() => { setEditing(null); setForm(EMPTY_FORM); setTargets([]); }}>Cancel edit</Button> : null}
        </div>
        <form onSubmit={submitPromotion} className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <label className="space-y-1 text-xs font-semibold">Name<Input required minLength={2} maxLength={120} value={form.name} onChange={(event) => updateForm("name", event.target.value)} /></label>
          <label className="space-y-1 text-xs font-semibold">Strategy<select className={inputClass} value={form.strategy} onChange={(event) => updateForm("strategy", event.target.value)}>
            <option value="PERCENTAGE_OFF">Percentage off</option><option value="FIXED_AMOUNT_OFF">Fixed amount off</option><option value="CART_THRESHOLD">Cart threshold + percentage</option><option value="QUANTITY_TIER">Quantity tier</option><option value="BUY_X_GET_Y">Buy X, get Y</option><option value="BUNDLE">Bundle discount</option><option value="FREE_SHIPPING">Free shipping (cannot activate yet)</option>
          </select></label>
          <label className="space-y-1 text-xs font-semibold">Campaign<select className={inputClass} value={form.campaignId} onChange={(event) => updateForm("campaignId", event.target.value)}><option value="">No campaign</option>{campaigns.map((campaign) => <option key={campaign.id} value={campaign.id}>{campaign.name} · {campaign.status}</option>)}</select></label>
          <label className="space-y-1 text-xs font-semibold">Description<Input maxLength={1000} value={form.description} onChange={(event) => updateForm("description", event.target.value)} /></label>
          <label className="space-y-1 text-xs font-semibold">Currency<Input maxLength={3} value={form.currency} onChange={(event) => updateForm("currency", event.target.value.toUpperCase())} /></label>
          <label className="space-y-1 text-xs font-semibold">Priority (higher number wins ties)<Input type="number" min={0} max={100000} value={form.priority} onChange={(event) => updateForm("priority", event.target.value)} /></label>

          {form.strategy === "FIXED_AMOUNT_OFF" ? <label className="space-y-1 text-xs font-semibold">Fixed discount (INR)<Input inputMode="decimal" value={form.amount} onChange={(event) => updateForm("amount", event.target.value)} /></label> : null}
          {["PERCENTAGE_OFF", "CART_THRESHOLD", "QUANTITY_TIER", "BUY_X_GET_Y", "BUNDLE"].includes(form.strategy) ? <label className="space-y-1 text-xs font-semibold">Discount percentage<Input inputMode="decimal" value={form.percent} onChange={(event) => updateForm("percent", event.target.value)} /><span className="block text-[10px] font-normal text-smoke">Up to two decimal places; stored as basis points.</span></label> : null}
          {form.strategy === "CART_THRESHOLD" ? <label className="space-y-1 text-xs font-semibold">Minimum cart amount (INR)<Input inputMode="decimal" value={form.threshold} onChange={(event) => updateForm("threshold", event.target.value)} /></label> : null}
          {form.strategy === "QUANTITY_TIER" ? <label className="space-y-1 text-xs font-semibold">Minimum eligible quantity<Input type="number" min={1} value={form.quantity} onChange={(event) => updateForm("quantity", event.target.value)} /></label> : null}
          {form.strategy === "BUY_X_GET_Y" ? <><label className="space-y-1 text-xs font-semibold">Buy quantity<Input type="number" min={1} value={form.buyQuantity} onChange={(event) => updateForm("buyQuantity", event.target.value)} /></label><label className="space-y-1 text-xs font-semibold">Reward quantity<Input type="number" min={1} value={form.getQuantity} onChange={(event) => updateForm("getQuantity", event.target.value)} /></label></> : null}
          {form.strategy === "BUNDLE" ? <label className="space-y-1 text-xs font-semibold">Minimum distinct products<Input type="number" min={2} value={form.distinctProducts} onChange={(event) => updateForm("distinctProducts", event.target.value)} /></label> : null}

          <label className="space-y-1 text-xs font-semibold">Starts at (your local time)<Input type="datetime-local" value={form.startsAt} onChange={(event) => updateForm("startsAt", event.target.value)} /></label>
          <label className="space-y-1 text-xs font-semibold">Ends at (your local time)<Input type="datetime-local" value={form.endsAt} onChange={(event) => updateForm("endsAt", event.target.value)} /></label>
          <label className="space-y-1 text-xs font-semibold">IANA time zone<Input value={form.timezone} onChange={(event) => updateForm("timezone", event.target.value)} /></label>
          <label className="space-y-1 text-xs font-semibold">Total usage limit (optional)<Input type="number" min={1} value={form.totalLimit} onChange={(event) => updateForm("totalLimit", event.target.value)} /></label>
          <label className="space-y-1 text-xs font-semibold">Per-customer limit (optional)<Input type="number" min={1} value={form.perCustomerLimit} onChange={(event) => updateForm("perCustomerLimit", event.target.value)} /></label>
          <label className="space-y-1 text-xs font-semibold">Coupon code (required unless automatic)<Input maxLength={64} value={form.code} onChange={(event) => updateForm("code", event.target.value.toUpperCase())} disabled={form.isAutomatic} placeholder="e.g. code configured by an editor" /></label>

          <fieldset className="space-y-2 rounded-xl border border-clay bg-paper p-3 md:col-span-2 xl:col-span-3">
            <legend className="px-1 text-xs font-semibold uppercase tracking-[0.12em]">Catalog/customer targets · AND across dimensions, OR within a dimension</legend>
            <div className="grid gap-2 sm:grid-cols-[1fr_1fr_2fr_auto]">
              <select className={inputClass} value={targetDimension} onChange={(event) => setTargetDimension(event.target.value as TargetRow["dimension"])}>{TARGET_DIMENSIONS.map((dimension) => <option key={dimension}>{dimension}</option>)}</select>
              <select className={inputClass} value={targetMode} onChange={(event) => setTargetMode(event.target.value as TargetRow["mode"])}><option value="INCLUDE">Include</option><option value="EXCLUDE">Exclude</option></select>
              <Input value={targetId} onChange={(event) => setTargetId(event.target.value)} placeholder="Existing catalog/customer UUID" />
              <Button type="button" variant="secondary" onClick={addTarget}>Add target</Button>
            </div>
            {targets.length ? <ul className="flex flex-wrap gap-2">{targets.map((target, index) => <li key={`${target.dimension}-${target.entityId}-${target.mode}`} className="rounded-full bg-sand px-3 py-1 text-[10px]">{target.mode} {target.dimension} · {target.entityId}<button type="button" className="ml-2 font-bold" aria-label="Remove target" onClick={() => setTargets((current) => current.filter((_, itemIndex) => itemIndex !== index))}>×</button></li>)}</ul> : <p className="text-[11px] text-smoke">No targets means all cart products; first-order, location, segment, shipping-method, and payment-method rules are not available.</p>}
          </fieldset>

          <fieldset className="flex flex-wrap gap-x-5 gap-y-2 rounded-xl border border-clay bg-paper p-3 md:col-span-2 xl:col-span-3">
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={form.isAutomatic} onChange={(event) => updateForm("isAutomatic", event.target.checked)} />Automatic cart promotion</label>
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={form.stackable} onChange={(event) => updateForm("stackable", event.target.checked)} />Stack with other stackable promotions</label>
            <span className="text-[11px] text-smoke">Use code-based promotions for usage limits; availability is reserved on checkout apply, not preview.</span>
          </fieldset>
          <div className="flex gap-2 md:col-span-2 xl:col-span-3"><Button type="submit" disabled={pending}>{pending ? "Saving…" : editing ? "Save new version" : "Create draft promotion"}</Button></div>
        </form>
      </section>

      <section className="rounded-card border border-clay bg-paper p-5">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-display text-xl font-bold uppercase">Campaigns</h2><p className="mt-1 text-xs text-smoke">Campaigns provide lifecycle and time-window grouping; each promotion still needs its own activation.</p></div></div>
        <form onSubmit={createCampaign} className="mt-4 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <Input required minLength={2} maxLength={120} value={campaignName} onChange={(event) => { setCampaignName(event.target.value); if (!campaignSlug) setCampaignSlug(event.target.value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")); }} placeholder="Campaign name" aria-label="Campaign name" />
          <Input required maxLength={100} value={campaignSlug} onChange={(event) => setCampaignSlug(event.target.value)} placeholder="url-safe-slug" aria-label="Campaign slug" />
          <Button type="submit" variant="secondary" disabled={pending}>Create draft</Button>
        </form>
        <div className="mt-4 divide-y divide-clay">{campaigns.map((campaign) => <div key={campaign.id} className="flex flex-wrap items-center justify-between gap-3 py-3"><div><p className="font-semibold">{campaign.name} <span className="font-mono text-xs text-smoke">/{campaign.slug}</span></p><p className="text-xs text-smoke">{campaign.status} · {campaign.promotionCount} promotion(s) · v{campaign.version}</p></div><div className="flex gap-2"><Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => void transitionCampaign(campaign, campaign.status === "ACTIVE" ? "PAUSE" : "ACTIVATE")}>{campaign.status === "ACTIVE" ? "Pause" : "Activate"}</Button><Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => void transitionCampaign(campaign, "ARCHIVE")}>Archive</Button></div></div>)}</div>
      </section>

      <section className="rounded-card border border-clay bg-cream p-5">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-display text-xl font-bold uppercase">Promotion rules</h2><p className="mt-1 text-xs text-smoke">State changes are version-checked; configuration snapshots and outbox events are transactional.</p></div><Button type="button" variant="secondary" disabled={pending} onClick={() => void reload()}>Refresh</Button></div>
        <div className="mt-4 space-y-3">{promotions.length ? promotions.map((row) => <article key={row.id} className="rounded-card border border-clay bg-paper p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">{row.name}</h3><Badge variant={row.status === "ACTIVE" ? "success" : row.status === "PAUSED" ? "warning" : "soft"}>{row.status}</Badge><Badge variant="soft">{row.strategy.replaceAll("_", " ")}</Badge></div>
              <p className="mt-1 text-xs text-smoke">{row.isAutomatic ? "Automatic" : `Coupon ${row.couponCodes.map((coupon) => coupon.code).join(", ") || "missing"}`} · {row.campaignName ?? "No campaign"} · priority {row.priority} · version {row.version}</p>
              <p className="mt-1 text-[11px] text-smoke">Targets: {row.targets.length ? row.targets.map((target) => `${target.mode.toLowerCase()} ${target.dimension.toLowerCase()}`).join(" · ") : "all products"} · {row.stackable ? "stackable" : "exclusive"}</p>
            </div>
            <div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => editPromotion(row)}>Edit</Button><Button type="button" size="sm" variant={row.status === "ACTIVE" ? "secondary" : "primary"} disabled={pending} onClick={() => void transitionPromotion(row, row.status === "ACTIVE" ? "PAUSE" : "ACTIVATE")}>{row.status === "ACTIVE" ? "Pause" : "Activate"}</Button><Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => void transitionPromotion(row, "ARCHIVE")}>Archive</Button><Button type="button" size="sm" variant="secondary" onClick={() => { setSimPromotionId(row.id); setSimCode(row.couponCodes[0]?.code ?? ""); document.getElementById("promotion-simulator")?.scrollIntoView({ behavior: "smooth" }); }}>Simulate</Button></div>
          </div>
        </article>) : <p className="rounded-xl border border-dashed border-clay p-5 text-sm text-smoke">No promotions yet. Create a draft above.</p>}</div>
      </section>

      <section id="promotion-simulator" className="rounded-card border border-clay bg-paper p-5">
        <h2 className="font-display text-xl font-bold uppercase">Live catalog simulation</h2>
        <p className="mt-1 max-w-3xl text-xs text-smoke">Prices and product relationships are loaded from the server. A simulation is read-only, cannot reserve usage capacity, cannot impersonate customers, and does not create an order.</p>
        <form onSubmit={runSimulation} className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <label className="space-y-1 text-xs font-semibold">Promotion<select className={inputClass} value={simPromotionId} onChange={(event) => setSimPromotionId(event.target.value)}><option value="">Active automatic promotions</option>{promotions.map((row) => <option key={row.id} value={row.id}>{row.name} · {row.status}</option>)}</select></label>
          <label className="space-y-1 text-xs font-semibold">Coupon code (optional)<Input value={simCode} onChange={(event) => setSimCode(event.target.value.toUpperCase())} maxLength={64} /></label>
          <label className="space-y-1 text-xs font-semibold">Product UUID<Input value={simProductId} onChange={(event) => setSimProductId(event.target.value)} required /></label>
          <label className="space-y-1 text-xs font-semibold">Variant UUID<Input value={simVariantId} onChange={(event) => setSimVariantId(event.target.value)} required /></label>
          <label className="space-y-1 text-xs font-semibold">Quantity<Input type="number" min={1} max={99} value={simQuantity} onChange={(event) => setSimQuantity(event.target.value)} /></label>
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={assumeActive} onChange={(event) => setAssumeActive(event.target.checked)} />Evaluate draft/paused rules as if active</label>
          <Button type="submit" disabled={pending}>Run simulation</Button>
        </form>
        {simulation ? <pre className="mt-4 max-h-80 overflow-auto rounded-xl bg-ink p-4 text-xs text-paper">{JSON.stringify(simulation, null, 2)}</pre> : null}
      </section>

      <section className="rounded-card border border-clay bg-paper p-5">
        <h2 className="font-display text-xl font-bold uppercase">Usage and reservations</h2>
        <p className="mt-1 text-xs text-smoke">A reservation is a temporary checkout hold, not a completed use. This application has no trusted order/payment completion hook; redeemed counts are not final redemption analytics.</p>
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">{analytics.map((row) => <article key={row.id} className="rounded-xl border border-clay p-4"><p className="font-semibold">{row.name} <span className="text-xs text-smoke">· {row.status}</span></p><p className="mt-2 text-xs">Reserved {row.reserved} · redeemed {row.redeemed} · released/expired {row.released}</p><p className="mt-1 text-xs text-smoke">Open reservation discount: {formatPrice(row.reservedDiscountPaise, { currency: row.currency })}</p></article>)}</div>
      </section>

      <section className="rounded-xl border border-warning/40 bg-warning/10 p-4 text-xs leading-relaxed text-smoke">
        Supported with this checkout integration: percentage/fixed cart discounts, cart thresholds, bounded quantity tiers, Buy X Get Y, bundle quantity, and product/category/brand/seller/collection/customer ID targeting. First-order/history, customer segments, geography, payment/shipping methods, real free shipping, catalog-detail promo badges, and final redemption are not enabled. Free-shipping rules are refused at activation until a final shipping quote exists.
      </section>
    </div>
  );
}
