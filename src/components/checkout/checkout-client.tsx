"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ComponentProps, type FormEvent } from "react";
import { AlertTriangle, ArrowLeft, CheckCircle2, CircleAlert, LockKeyhole, MapPin, RefreshCw } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { formatPrice } from "@/lib/format";
import type { CheckoutSessionDTO } from "@/services/checkout/checkout.service";
import type { CheckoutAddressSnapshot } from "@/db/schema";

const SESSION_STORAGE_KEY = "inkline.checkout.session";
const START_KEY_PREFIX = "inkline.checkout.start:";

type SavedAddress = {
  id: string;
  version: number;
  fullName: string;
  phone: string;
  addressLine1: string;
  addressLine2: string | null;
  locality: string | null;
  landmark: string | null;
  deliveryInstructions: string | null;
  city: string;
  state: string | null;
  postalCode: string | null;
  country: string;
  addressType: "HOME" | "WORK" | "OTHER";
  isDefault: boolean;
  isDefaultBilling: boolean;
};

type AddressDraft = {
  fullName: string;
  phone: string;
  addressLine1: string;
  addressLine2: string;
  locality: string;
  landmark: string;
  deliveryInstructions: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  addressType: "HOME" | "WORK" | "OTHER";
};

type ApiEnvelope<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

class CheckoutClientError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message);
  }
}

function emptyAddress(): AddressDraft {
  return {
    fullName: "",
    phone: "",
    addressLine1: "",
    addressLine2: "",
    locality: "",
    landmark: "",
    deliveryInstructions: "",
    city: "",
    state: "",
    postalCode: "",
    country: "IN",
    addressType: "HOME",
  };
}

function draftFromSnapshot(snapshot: CheckoutAddressSnapshot | null | undefined): AddressDraft {
  if (!snapshot) return emptyAddress();
  return {
    fullName: snapshot.fullName,
    phone: snapshot.phone,
    addressLine1: snapshot.addressLine1,
    addressLine2: snapshot.addressLine2 ?? "",
    locality: snapshot.locality ?? "",
    landmark: snapshot.landmark ?? "",
    deliveryInstructions: snapshot.deliveryInstructions ?? "",
    city: snapshot.city,
    state: snapshot.state ?? "",
    postalCode: snapshot.postalCode ?? "",
    country: snapshot.country,
    addressType: snapshot.addressType,
  };
}

function draftFromSaved(address: SavedAddress): AddressDraft {
  return {
    fullName: address.fullName,
    phone: address.phone,
    addressLine1: address.addressLine1,
    addressLine2: address.addressLine2 ?? "",
    locality: address.locality ?? "",
    landmark: address.landmark ?? "",
    deliveryInstructions: address.deliveryInstructions ?? "",
    city: address.city,
    state: address.state ?? "",
    postalCode: address.postalCode ?? "",
    country: address.country,
    addressType: address.addressType,
  };
}

function toAddressPayload(draft: AddressDraft) {
  return {
    ...draft,
    isDefaultShipping: false,
    isDefaultBilling: false,
  };
}

function newIdempotencyKey(scope: string): string {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${scope}-${id}`;
}

async function apiRequest<T>(path: string, options: {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  idempotencyKey?: string;
} = {}): Promise<T> {
  const headers = new Headers();
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (options.idempotencyKey) headers.set("Idempotency-Key", options.idempotencyKey);
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    credentials: "same-origin",
    cache: "no-store",
  });
  const envelope = (await response.json()) as ApiEnvelope<T>;
  if (!response.ok || !envelope.ok) {
    const failure = envelope.ok ? { code: "REQUEST_FAILED", message: "The request could not be completed." } : envelope.error;
    throw new CheckoutClientError(failure.message, failure.code, response.status);
  }
  return envelope.data;
}

function AddressFields({
  value,
  onChange,
  prefix,
  disabled,
}: {
  value: AddressDraft;
  onChange: (next: AddressDraft) => void;
  prefix: string;
  disabled: boolean;
}) {
  const update = (key: keyof AddressDraft, next: string) =>
    onChange({ ...value, [key]: key === "country" ? next.toUpperCase().slice(0, 2) : next });
  const field = (key: keyof AddressDraft, label: string, props: ComponentProps<typeof Input> = {}) => (
    <Field key={key} label={label} required={
      ["fullName", "phone", "addressLine1", "city", "country"].includes(key) ||
      ((key === "state" || key === "postalCode") && value.country === "IN")
    }>
      <Input
        id={`${prefix}-${key}`}
        value={value[key] as string}
        onChange={(event) => update(key, event.target.value)}
        disabled={disabled}
        autoComplete={key === "fullName" ? "name" : key === "phone" ? "tel" : key === "addressLine1" ? "address-line1" : key === "addressLine2" ? "address-line2" : key === "city" ? "address-level2" : key === "state" ? "address-level1" : key === "postalCode" ? "postal-code" : key === "country" ? "country" : undefined}
        maxLength={key === "country" ? 2 : undefined}
        placeholder={key === "country" ? "IN" : undefined}
        {...props}
      />
    </Field>
  );

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field label="Address label" required>
        <select
          id={`${prefix}-addressType`}
          value={value.addressType}
          onChange={(event) => onChange({ ...value, addressType: event.target.value as AddressDraft["addressType"] })}
          disabled={disabled}
          className="h-11 w-full rounded-full border-[1.5px] border-clay bg-white/60 px-5 text-sm focus:border-ink focus:outline-2 focus:outline-offset-2 focus:outline-flame disabled:opacity-50"
        >
          <option value="HOME">Home</option>
          <option value="WORK">Work</option>
          <option value="OTHER">Other</option>
        </select>
      </Field>
      {field("fullName", "Full name")}
      {field("phone", "Phone", { type: "tel", placeholder: "+91 98765 43210" })}
      <div className="sm:col-span-2">{field("addressLine1", "Address line 1", { placeholder: "House or building, street" })}</div>
      <div className="sm:col-span-2">{field("addressLine2", "Address line 2 (optional)", { placeholder: "Apartment, suite, floor" })}</div>
      {field("locality", "District / locality (optional)")}
      {field("landmark", "Landmark (optional)")}
      {field("city", "City / town")}
      {field("state", value.country === "IN" ? "State / region" : "State / province / region (optional)", { required: value.country === "IN" })}
      {field("postalCode", value.country === "IN" ? "PIN code" : value.country === "US" ? "ZIP code" : "Postal code (if used)", { inputMode: value.country === "IN" ? "numeric" : "text", maxLength: 20 })}
      {field("country", "Country code", { placeholder: "IN" })}
      <div className="sm:col-span-2">{field("deliveryInstructions", "Delivery instructions (optional)", { placeholder: "Gate code or safe drop-off note" })}</div>
      <p className="sm:col-span-2 -mt-1 text-xs text-smoke">Country-aware format checks are applied. The address is not physically verified.</p>
    </div>
  );
}

export function CheckoutClient() {
  const [session, setSession] = useState<CheckoutSessionDTO | null>(null);
  const [savedAddresses, setSavedAddresses] = useState<SavedAddress[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noCart, setNoCart] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [couponCode, setCouponCode] = useState("");
  const [contact, setContact] = useState({ name: "", email: "", phone: "" });
  const [shippingSelection, setShippingSelection] = useState("NEW");
  const [billingSelection, setBillingSelection] = useState("NEW");
  const [billingSame, setBillingSame] = useState(true);
  const [shippingDraft, setShippingDraft] = useState<AddressDraft>(emptyAddress());
  const [billingDraft, setBillingDraft] = useState<AddressDraft>(emptyAddress());
  const [saveShipping, setSaveShipping] = useState(true);
  const [saveBilling, setSaveBilling] = useState(true);
  const addressDraftInitialized = useRef(false);

  const loadSavedAddresses = useCallback(async () => {
    try {
      const addresses = await apiRequest<SavedAddress[]>("/api/addresses");
      setSavedAddresses(addresses);
    } catch {
      setSavedAddresses([]);
    }
  }, []);

  useEffect(() => {
    let active = true;
    async function start() {
      setLoading(true);
      setError(null);
      try {
        const existingId = sessionStorage.getItem(SESSION_STORAGE_KEY);
        if (existingId) {
          try {
            const restored = await apiRequest<CheckoutSessionDTO>(`/api/checkout/session/${encodeURIComponent(existingId)}`);
            if (!active) return;
            setSession(restored);
            setContact(restored.contact ?? { name: "", email: "", phone: "" });
            void loadSavedAddresses();
            setLoading(false);
            return;
          } catch (cause) {
            if (cause instanceof CheckoutClientError && cause.code === "CHECKOUT_ACCESS_DENIED") {
              // Do not claim a guest session from an email match; start a new owner-scoped session instead.
            }
            sessionStorage.removeItem(SESSION_STORAGE_KEY);
            for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
              const key = sessionStorage.key(index);
              if (key?.startsWith(START_KEY_PREFIX)) sessionStorage.removeItem(key);
            }
          }
        }

        const cart = await apiRequest<{ id: string | null; items: unknown[] }>("/api/cart");
        if (!active) return;
        if (!cart.id || cart.items.length === 0) {
          setNoCart(true);
          setLoading(false);
          return;
        }
        setNoCart(false);
        const startKeyName = `${START_KEY_PREFIX}${cart.id}`;
        let idempotencyKey = sessionStorage.getItem(startKeyName);
        if (!idempotencyKey) {
          idempotencyKey = newIdempotencyKey("checkout-start");
          sessionStorage.setItem(startKeyName, idempotencyKey);
        }
        const started = await apiRequest<CheckoutSessionDTO>("/api/checkout/session", {
          method: "POST",
          body: {},
          idempotencyKey,
        });
        if (!active) return;
        sessionStorage.setItem(SESSION_STORAGE_KEY, started.id);
        setSession(started);
        setContact(started.contact ?? { name: "", email: "", phone: "" });
        void loadSavedAddresses();
      } catch (cause) {
        if (!active) return;
        if (cause instanceof CheckoutClientError && cause.code === "CART_EMPTY") setNoCart(true);
        else setError(cause instanceof Error ? cause.message : "Checkout could not be started. Try again from your cart.");
      } finally {
        if (active) setLoading(false);
      }
    }
    void start();
    return () => { active = false; };
  }, [loadSavedAddresses]);

  useEffect(() => {
    if (!session || addressDraftInitialized.current) return;
    setShippingDraft(draftFromSnapshot(session.shippingAddress));
    setBillingDraft(draftFromSnapshot(session.billingAddress));
    setBillingSame(session.billingSameAsShipping);
    setShippingSelection(session.shippingAddress?.source === "SAVED" && session.shippingAddress.sourceAddressId
      ? session.shippingAddress.sourceAddressId
      : "NEW");
    setBillingSelection(session.billingAddress?.source === "SAVED" && session.billingAddress.sourceAddressId
      ? session.billingAddress.sourceAddressId
      : "NEW");
    addressDraftInitialized.current = true;
  }, [session]);

  const reloadSummary = useCallback(async () => {
    if (!session) return;
    const updated = await apiRequest<CheckoutSessionDTO>(`/api/checkout/session/${session.id}/summary`);
    setSession(updated);
    return updated;
  }, [session]);

  async function mutate(path: string, method: "PATCH" | "POST" | "DELETE", body: Record<string, unknown>, scope: string): Promise<CheckoutSessionDTO | null> {
    if (!session || pending) return null;
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await apiRequest<CheckoutSessionDTO>(path, {
        method,
        body,
        idempotencyKey: newIdempotencyKey(`checkout-${scope}`),
      });
      setSession(updated);
      return updated;
    } catch (cause) {
      if (cause instanceof CheckoutClientError && cause.code === "CHECKOUT_VERSION_CONFLICT") {
        try { await reloadSummary(); } catch { /* preserve original conflict message */ }
      }
      setError(cause instanceof Error ? cause.message : "Checkout could not be updated.");
      return null;
    } finally {
      setPending(false);
    }
  }

  async function submitContact(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) return;
    const saved = await mutate(`/api/checkout/session/${session.id}/contact`, "PATCH", {
      expectedVersion: session.version,
      contact,
    }, "contact");
    if (saved) setNotice("Contact details saved to this guest checkout session only.");
  }

  async function submitCoupon(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || !couponCode.trim()) return;
    const updated = await mutate(`/api/checkout/session/${session.id}/coupon`, "POST", {
      expectedVersion: session.version,
      code: couponCode,
    }, "coupon");
    if (updated) setCouponCode(updated.appliedCoupon?.code ?? "");
  }

  async function removeCoupon() {
    if (!session) return;
    const updated = await mutate(`/api/checkout/session/${session.id}/coupon`, "DELETE", {
      expectedVersion: session.version,
    }, "coupon-remove");
    if (updated) setCouponCode("");
  }

  async function createBookAddress(draft: AddressDraft): Promise<string | null> {
    const created = await apiRequest<{ address: SavedAddress; possibleDuplicate: boolean }>("/api/addresses", {
      method: "POST",
      body: toAddressPayload(draft),
    });
    setSavedAddresses((rows) => [created.address, ...rows.filter((row) => row.id !== created.address.id)]);
    if (created.possibleDuplicate) setNotice("Address saved. It resembles another saved address; nothing was merged.");
    return created.address.id;
  }

  async function submitAddresses(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) return;
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      let shippingAddressId: string | null | undefined;
      let shippingAddress: ReturnType<typeof toAddressPayload> | undefined;
      if (shippingSelection !== "NEW") shippingAddressId = shippingSelection;
      else if (session.customerType === "ACCOUNT" && saveShipping) shippingAddressId = await createBookAddress(shippingDraft) ?? undefined;
      else shippingAddress = toAddressPayload(shippingDraft);

      let billingAddressId: string | null | undefined;
      let billingAddress: ReturnType<typeof toAddressPayload> | undefined;
      if (!billingSame) {
        if (billingSelection !== "NEW") billingAddressId = billingSelection;
        else if (session.customerType === "ACCOUNT" && saveBilling) billingAddressId = await createBookAddress(billingDraft) ?? undefined;
        else billingAddress = toAddressPayload(billingDraft);
      }

      const body = {
        expectedVersion: session.version,
        ...(shippingAddressId !== undefined ? { shippingAddressId } : {}),
        ...(shippingAddress ? { shippingAddress } : {}),
        billingSameAsShipping: billingSame,
        ...(!billingSame && billingAddressId !== undefined ? { billingAddressId } : {}),
        ...(!billingSame && billingAddress ? { billingAddress } : {}),
      };
      const updated = await apiRequest<CheckoutSessionDTO>(`/api/checkout/session/${session.id}/address`, {
        method: "PATCH",
        body,
        idempotencyKey: newIdempotencyKey("checkout-address"),
      });
      setSession(updated);
      if (shippingAddressId) setShippingSelection(shippingAddressId);
      if (!billingSame && billingAddressId) setBillingSelection(billingAddressId);
      setNotice("Address selection saved. Address-format validation does not verify physical deliverability.");
    } catch (cause) {
      if (cause instanceof CheckoutClientError && cause.code === "CHECKOUT_VERSION_CONFLICT") {
        try { await reloadSummary(); } catch { /* retain conflict copy */ }
      }
      setError(cause instanceof Error ? cause.message : "Address details could not be saved.");
    } finally {
      setPending(false);
    }
  }

  async function acknowledgeCartChanges() {
    if (!session) return;
    const updated = await mutate(`/api/checkout/session/${session.id}/revalidate`, "POST", {
      expectedVersion: session.version,
      acknowledgeCartChanges: true,
    }, "revalidate");
    if (updated) setNotice("The current cart version was reviewed. Price and stock warnings still need to be resolved in the cart.");
  }

  async function refreshValidation() {
    if (!session) return;
    const updated = await mutate(`/api/checkout/session/${session.id}/revalidate`, "POST", {
      expectedVersion: session.version,
      acknowledgeCartChanges: false,
    }, "revalidate");
    if (updated) setNotice("Checkout was revalidated against current server data.");
  }

  async function selectDelivery(methodId: string) {
    if (!session) return;
    await mutate(`/api/checkout/session/${session.id}/delivery`, "PATCH", {
      expectedVersion: session.version,
      deliveryMethodId: methodId,
    }, "delivery");
  }

  function changeShippingSelection(value: string) {
    setShippingSelection(value);
    if (value === "NEW") setShippingDraft(draftFromSnapshot(session?.shippingAddress));
    else {
      const found = savedAddresses.find((address) => address.id === value);
      if (found) setShippingDraft(draftFromSaved(found));
    }
  }

  function changeBillingSelection(value: string) {
    setBillingSelection(value);
    if (value === "NEW") setBillingDraft(draftFromSnapshot(session?.billingAddress));
    else {
      const found = savedAddresses.find((address) => address.id === value);
      if (found) setBillingDraft(draftFromSaved(found));
    }
  }

  if (loading) {
    return (
      <main className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-8" aria-busy="true" aria-label="Loading checkout">
        <div className="h-8 w-52 animate-pulse rounded bg-sand" />
        <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="h-96 animate-pulse rounded-card bg-sand" />
          <div className="h-72 animate-pulse rounded-card bg-sand" />
        </div>
      </main>
    );
  }

  if (noCart) {
    return (
      <main className="mx-auto w-full max-w-3xl px-4 py-16 text-center sm:px-8">
        <MapPin className="mx-auto size-8 text-flame" aria-hidden />
        <h1 className="mt-4 font-display text-3xl font-extrabold uppercase">Your cart is empty</h1>
        <p className="mt-3 text-sm text-smoke">Add a product to start checkout preparation. No payment or order is created here.</p>
        <Button asChild className="mt-6"><Link href="/shop">Browse the shop</Link></Button>
      </main>
    );
  }

  if (!session) {
    return (
      <main className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-8">
        <Link href="/cart" className="inline-flex items-center gap-2 text-sm underline decoration-flame underline-offset-4"><ArrowLeft className="size-4" aria-hidden /> Back to cart</Link>
        <h1 className="mt-5 font-display text-3xl font-extrabold uppercase">Checkout could not start</h1>
        {error ? <Alert variant="error" className="mt-5">{error}</Alert> : null}
        <Button variant="outline" className="mt-5" onClick={() => window.location.reload()}>Try again</Button>
      </main>
    );
  }

  const cartChanged = session.issues.some((issue) => issue.code === "CART_CHANGED");
  const blockedByStoreIntegration = session.issues.some((issue) => ["DELIVERY_UNAVAILABLE", "TAX_NOT_CONFIGURED", "TAX_UNAVAILABLE"].includes(issue.code));

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-8 lg:py-12">
      <div className="mb-7 flex flex-wrap items-center justify-between gap-4">
        <div>
          <Link href="/cart" className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] underline decoration-flame underline-offset-4"><ArrowLeft className="size-3.5" aria-hidden /> Back to cart</Link>
          <h1 className="mt-3 font-display text-3xl font-extrabold uppercase sm:text-4xl">Checkout preparation</h1>
          <p className="mt-1 text-sm text-smoke">Review customer, address, cart and delivery details. This is not a payment or order.</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={session.status === "READY" ? "success" : "warning"}>{session.status.replaceAll("_", " ")}</Badge>
          <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => void refreshValidation()}>
            <RefreshCw className="size-3.5" aria-hidden /> Recheck
          </Button>
        </div>
      </div>

      {error ? <Alert variant="error" className="mb-5">{error}</Alert> : null}
      {notice ? <Alert variant="success" className="mb-5">{notice}</Alert> : null}
      {session.issues.some((issue) => issue.severity === "BLOCKING") ? (
        <section className="mb-6 rounded-card border border-warning/50 bg-warning/10 p-4" aria-labelledby="checkout-issues-title">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
            <div className="min-w-0">
              <h2 id="checkout-issues-title" className="text-sm font-semibold">Checkout needs attention</h2>
              <ul className="mt-2 space-y-2 text-sm text-smoke">
                {session.issues.filter((issue) => issue.severity === "BLOCKING").map((issue, index) => (
                  <li key={`${issue.code}-${issue.itemId ?? index}`}><span className="font-mono text-[10px] uppercase">{issue.code.replaceAll("_", " ")}</span> — {issue.message}</li>
                ))}
              </ul>
              {cartChanged ? (
                <Button size="sm" variant="outline" className="mt-3" disabled={pending} onClick={() => void acknowledgeCartChanges()}>
                  I reviewed the current cart
                </Button>
              ) : null}
              {session.issues.some((issue) => ["PRICE_CHANGED", "STOCK_REDUCED", "OUT_OF_STOCK", "PRODUCT_UNAVAILABLE", "VARIANT_UNAVAILABLE", "SELLER_UNAVAILABLE", "QUANTITY_LIMIT", "CURRENCY_MISMATCH"].includes(issue.code)) ? (
                <Link href="/cart" className="ml-3 inline-flex min-h-10 items-center text-xs font-semibold underline decoration-flame underline-offset-4">Review or fix the cart</Link>
              ) : null}
            </div>
          </div>
        </section>
      ) : (
        <Alert variant="success" className="mb-6"><CheckCircle2 className="size-4" aria-hidden /> Server checks pass. No payment was started and stock is not reserved.</Alert>
      )}

      <div className="grid items-start gap-7 lg:grid-cols-[minmax(0,1fr)_23rem]">
        <div className="space-y-6">
          {session.customerType === "GUEST" ? (
            <form onSubmit={(event) => void submitContact(event)} className="space-y-4 rounded-card border-[1.5px] border-clay bg-cream p-5 sm:p-6">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-smoke">01 · Contact</p>
                <h2 className="mt-1 font-display text-xl font-bold uppercase">Guest details</h2>
                <p className="mt-1 text-xs text-smoke">These details belong to this browser-bound checkout and are not used to claim an account.</p>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Full name" required>
                  <Input value={contact.name} onChange={(event) => setContact((value) => ({ ...value, name: event.target.value }))} autoComplete="name" disabled={pending} />
                </Field>
                <Field label="Email" required>
                  <Input type="email" value={contact.email} onChange={(event) => setContact((value) => ({ ...value, email: event.target.value }))} autoComplete="email" disabled={pending} />
                </Field>
                <Field label="Phone" required description="Use an international country prefix if applicable.">
                  <Input type="tel" value={contact.phone} onChange={(event) => setContact((value) => ({ ...value, phone: event.target.value }))} autoComplete="tel" placeholder="+91 98765 43210" disabled={pending} />
                </Field>
              </div>
              <Button type="submit" size="sm" disabled={pending}>Save contact</Button>
            </form>
          ) : (
            <section className="rounded-card border-[1.5px] border-clay bg-cream p-5 sm:p-6">
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-smoke">01 · Contact</p>
              <h2 className="mt-1 font-display text-xl font-bold uppercase">Account contact</h2>
              <p className="mt-2 text-sm font-semibold">{session.contact?.name || "Name not set"}</p>
              <p className="text-sm text-smoke">{session.contact?.email}</p>
              {session.contact?.phone ? <p className="text-sm text-smoke">{session.contact.phone}</p> : null}
              <Link href="/account/profile" className="mt-3 inline-flex min-h-10 items-center text-xs font-semibold underline decoration-flame underline-offset-4">Manage profile</Link>
            </section>
          )}

          <form onSubmit={(event) => void submitAddresses(event)} className="space-y-5 rounded-card border-[1.5px] border-clay bg-cream p-5 sm:p-6">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-smoke">02 · Addresses</p>
              <h2 className="mt-1 font-display text-xl font-bold uppercase">Shipping and billing</h2>
              <p className="mt-1 text-xs text-smoke">Format validation is server-side. It does not verify a physical address or delivery serviceability.</p>
            </div>

            <section className="space-y-4 rounded-card border border-clay/80 bg-paper p-4">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold">Shipping address</h3>
                  <p className="mt-0.5 text-xs text-smoke">Required to request delivery options.</p>
                </div>
                {session.customerType === "ACCOUNT" ? <Link href="/account/addresses" className="text-xs font-semibold underline decoration-flame underline-offset-4">Manage address book</Link> : null}
              </div>
              {session.customerType === "ACCOUNT" ? (
                <Field label="Choose a saved address or enter a new one">
                  <select value={shippingSelection} onChange={(event) => changeShippingSelection(event.target.value)} disabled={pending} className="h-11 w-full rounded-full border-[1.5px] border-clay bg-white/60 px-5 text-sm focus:outline-2 focus:outline-flame disabled:opacity-50">
                    <option value="NEW">Enter a new address</option>
                    {savedAddresses.map((address) => <option key={address.id} value={address.id}>{address.addressType} · {address.fullName} · {address.city}{address.isDefault ? " · Default shipping" : ""}</option>)}
                  </select>
                </Field>
              ) : null}
              {shippingSelection === "NEW" ? (
                <>
                  <AddressFields value={shippingDraft} onChange={setShippingDraft} prefix="shipping" disabled={pending} />
                  {session.customerType === "ACCOUNT" ? (
                    <label className="flex items-start gap-2.5 text-xs text-smoke">
                      <input type="checkbox" checked={saveShipping} onChange={(event) => setSaveShipping(event.target.checked)} disabled={pending} className="mt-0.5 size-4 accent-flame" />
                      Save this address to my account address book
                    </label>
                  ) : null}
                </>
              ) : (
                <SavedAddressSummary address={savedAddresses.find((address) => address.id === shippingSelection)} snapshot={session.shippingAddress} />
              )}
            </section>

            <label className="flex cursor-pointer items-start gap-2.5 text-sm">
              <input type="checkbox" checked={billingSame} onChange={(event) => setBillingSame(event.target.checked)} disabled={pending} className="mt-0.5 size-4 accent-flame" />
              <span><span className="font-semibold">Billing address is the same as shipping</span><span className="mt-0.5 block text-xs text-smoke">You can choose a separate billing address below.</span></span>
            </label>

            {!billingSame ? (
              <section className="space-y-4 rounded-card border border-clay/80 bg-paper p-4">
                <div>
                  <h3 className="text-sm font-semibold">Billing address</h3>
                  <p className="mt-0.5 text-xs text-smoke">Select a saved address or enter a separate one.</p>
                </div>
                {session.customerType === "ACCOUNT" ? (
                  <Field label="Choose a saved address or enter a new one">
                    <select value={billingSelection} onChange={(event) => changeBillingSelection(event.target.value)} disabled={pending} className="h-11 w-full rounded-full border-[1.5px] border-clay bg-white/60 px-5 text-sm focus:outline-2 focus:outline-flame disabled:opacity-50">
                      <option value="NEW">Enter a new address</option>
                      {savedAddresses.map((address) => <option key={address.id} value={address.id}>{address.addressType} · {address.fullName} · {address.city}{address.isDefaultBilling ? " · Default billing" : ""}</option>)}
                    </select>
                  </Field>
                ) : null}
                {billingSelection === "NEW" ? (
                  <>
                    <AddressFields value={billingDraft} onChange={setBillingDraft} prefix="billing" disabled={pending} />
                    {session.customerType === "ACCOUNT" ? (
                      <label className="flex items-start gap-2.5 text-xs text-smoke">
                        <input type="checkbox" checked={saveBilling} onChange={(event) => setSaveBilling(event.target.checked)} disabled={pending} className="mt-0.5 size-4 accent-flame" />
                        Save this billing address to my account address book
                      </label>
                    ) : null}
                  </>
                ) : (
                  <SavedAddressSummary address={savedAddresses.find((address) => address.id === billingSelection)} snapshot={session.billingAddress} />
                )}
              </section>
            ) : null}
            <Button type="submit" size="md" disabled={pending}>{pending ? "Saving…" : "Save address selection"}</Button>
          </form>

          <section className="space-y-4 rounded-card border-[1.5px] border-clay bg-cream p-5 sm:p-6" aria-labelledby="delivery-title">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-smoke">03 · Delivery</p>
              <h2 id="delivery-title" className="mt-1 font-display text-xl font-bold uppercase">Delivery options</h2>
            </div>
            {session.delivery.options.length ? (
              <div className="space-y-3">
                {session.delivery.options.map((option) => (
                  <button key={option.id} type="button" disabled={pending} onClick={() => void selectDelivery(option.id)} className={`w-full rounded-card border-[1.5px] p-4 text-left transition-colors ${session.delivery.selected?.id === option.id ? "border-flame bg-flame/5" : "border-clay bg-paper hover:border-ink"}`}>
                    <span className="flex flex-wrap items-center justify-between gap-3">
                      <span><span className="block text-sm font-semibold">{option.name}</span><span className="mt-1 block text-xs text-smoke">{option.description}</span></span>
                      <span className="font-mono text-sm">{option.amountPaise === null ? "Quote required" : formatPrice(option.amountPaise, { currency: option.currency })}</span>
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="rounded-card border border-warning/40 bg-warning/10 p-4">
                <div className="flex items-start gap-3">
                  <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                  <div>
                    <p className="text-sm font-semibold">Delivery is not configured</p>
                    <p className="mt-1 text-sm text-smoke">{session.delivery.message} No method or rate is being invented from product margin estimates.</p>
                    <p className="mt-2 text-xs text-smoke">The store needs a real delivery provider or explicitly configured serviceability and quotes before checkout can be marked READY.</p>
                  </div>
                </div>
              </div>
            )}
          </section>

          <section className="space-y-4 rounded-card border-[1.5px] border-clay bg-cream p-5 sm:p-6">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-smoke">04 · Review</p>
              <h2 className="mt-1 font-display text-xl font-bold uppercase">Cart and totals</h2>
            </div>
            {session.items.length === 0 ? <p className="text-sm text-smoke">Your cart is currently empty.</p> : (
              <ul className="divide-y divide-clay rounded-card border border-clay bg-paper px-4">
                {session.items.map((item) => (
                  <li key={item.cartItemId} className="flex flex-wrap items-start justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold">{item.productName}</p>
                      <p className="mt-0.5 text-xs text-smoke">{item.variantName} · Qty {item.quantity}{item.sellerName ? ` · ${item.sellerName}` : ""}</p>
                    </div>
                    <p className="font-mono text-sm">{item.lineSubtotalPaise === null ? "Price unavailable" : formatPrice(item.lineSubtotalPaise, { currency: item.currency })}</p>
                  </li>
                ))}
              </ul>
            )}
            {session.fulfillmentGroups.length > 1 ? (
              <div className="rounded-card border border-clay bg-paper p-4">
                <h3 className="text-xs font-semibold uppercase tracking-[0.12em]">Seller fulfillment groups</h3>
                <ul className="mt-2 space-y-1 text-xs text-smoke">
                  {session.fulfillmentGroups.map((group) => <li key={group.sellerId ?? "unknown"}>{group.sellerName} · {group.itemsCount} items{group.subtotalPaise === null ? " · subtotal unavailable" : ` · ${formatPrice(group.subtotalPaise, { currency: session.currency })}`}</li>)}
                </ul>
                <p className="mt-2 text-[11px] text-smoke">No orders or split shipments are created by this grouping.</p>
              </div>
            ) : null}
          </section>
        </div>

        <aside className="space-y-4 lg:sticky lg:top-24">
          <section className="rounded-card border-[1.5px] border-ink bg-cream p-5 sm:p-6" aria-labelledby="totals-title">
            <h2 id="totals-title" className="font-display text-xl font-bold uppercase">Server-derived summary</h2>
            <form onSubmit={submitCoupon} className="mt-4 space-y-2" aria-label="Apply promotion code">
              <label htmlFor="checkout-coupon" className="text-xs font-semibold uppercase tracking-[0.12em]">Promotion code</label>
              <div className="flex gap-2">
                <Input id="checkout-coupon" value={couponCode} onChange={(event) => setCouponCode(event.target.value)} autoComplete="off" maxLength={64} disabled={pending} placeholder="Enter code" />
                <Button type="submit" disabled={pending || couponCode.trim().length < 3}>Apply</Button>
              </div>
            </form>
            {session.appliedCoupon ? (
              <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-clay bg-paper p-3 text-xs" role="status">
                <span>{session.appliedCoupon.applied ? `${session.appliedCoupon.code} applied · −${formatPrice(session.appliedCoupon.discountPaise, { currency: session.currency })}` : `${session.appliedCoupon.code} is unavailable for this cart.`}</span>
                <Button type="button" variant="outline" disabled={pending} onClick={() => void removeCoupon()}>Remove</Button>
              </div>
            ) : null}
            {session.appliedPromotions.filter((promotion) => !promotion.couponId).map((promotion) => (
              <p key={promotion.promotionId} className="mt-2 text-xs text-success">{promotion.name} · −{formatPrice(promotion.discountPaise, { currency: session.currency })}</p>
            ))}
            <dl className="mt-5 space-y-3 border-b border-clay pb-5 text-sm">
              <div className="flex justify-between gap-4"><dt>List-price subtotal</dt><dd className="font-mono">{formatPrice(session.totals.listSubtotalPaise, { currency: session.currency })}</dd></div>
              {session.totals.discountPaise > 0 ? <div className="flex justify-between gap-4 text-success"><dt>Discounts</dt><dd className="font-mono">−{formatPrice(session.totals.discountPaise, { currency: session.currency })}</dd></div> : null}
              <div className="flex justify-between gap-4"><dt>Subtotal after discounts</dt><dd className="font-mono">{formatPrice(session.totals.subtotalPaise, { currency: session.currency })}</dd></div>
              <div className="flex justify-between gap-4"><dt>Tax · {session.totals.taxStatus === "AUTHORITATIVE" ? "provider quote" : session.totals.taxStatus === "CATALOG_ESTIMATE" ? "estimate only" : "unavailable"}</dt><dd className="font-mono">{session.totals.estimatedTaxPaise === null ? "Unavailable" : formatPrice(session.totals.estimatedTaxPaise, { currency: session.currency })}</dd></div>
              <div className="flex justify-between gap-4"><dt>Delivery</dt><dd className="font-mono">{session.totals.shippingPaise === null ? "Not available" : formatPrice(session.totals.shippingPaise, { currency: session.currency })}</dd></div>
            </dl>
            <div className="mt-4 flex items-baseline justify-between gap-3">
              <dt className="font-semibold">Current estimate</dt>
              <dd className="font-mono text-lg font-bold">{session.totals.totalEstimatePaise === null ? "Incomplete" : formatPrice(session.totals.totalEstimatePaise, { currency: session.currency })}</dd>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-smoke">{session.taxMessage} This estimate is not a final payable total.</p>
            <p className="mt-3 rounded-xl border border-clay bg-paper p-3 text-xs leading-relaxed text-smoke">Stock is checked live but not reserved. READY, if available later, would only mean checkout validation passed; it is not payment, order creation or completion.</p>
            {blockedByStoreIntegration ? <p className="mt-3 text-xs font-semibold text-warning">Store configuration is required before READY.</p> : null}
            <Button type="button" disabled className="mt-5 w-full" aria-describedby="payment-placeholder-note">
              <LockKeyhole className="size-4" aria-hidden /> {session.isReady ? "Payment integration not configured" : "Not ready for payment"}
            </Button>
            <p id="payment-placeholder-note" className="mt-2 text-center text-xs text-smoke">No payment request or order is created.</p>
          </section>
          <section className="rounded-card border border-clay bg-paper p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.12em]">Recovery</p>
            <p className="mt-2 text-xs leading-relaxed text-smoke">Session version {session.version} · expires {new Date(session.expiresAt).toLocaleString()}</p>
            <p className="mt-1 text-xs text-smoke">Cart version reviewed: {session.cartVersion} · current version: {session.observedCartVersion}</p>
            <Button type="button" variant="outline" size="sm" className="mt-3 w-full" disabled={pending} onClick={() => void reloadSummary().catch((cause) => setError(cause instanceof Error ? cause.message : "Refresh failed."))}>
              <RefreshCw className="size-3.5" aria-hidden /> Refresh current validation
            </Button>
          </section>
        </aside>
      </div>
    </main>
  );
}

function SavedAddressSummary({ address, snapshot }: { address?: SavedAddress; snapshot: CheckoutAddressSnapshot | null }) {
  const source = address ? draftFromSaved(address) : draftFromSnapshot(snapshot);
  if (!snapshot && !address) return <p className="text-sm text-smoke">Choose or enter an address.</p>;
  return (
    <address className="rounded-card border border-clay bg-paper p-4 text-sm not-italic leading-relaxed">
      <span className="font-semibold">{source.fullName}</span><br />
      {source.addressLine1}{source.addressLine2 ? `, ${source.addressLine2}` : ""}{source.locality ? `, ${source.locality}` : ""}<br />
      {source.city}{source.state ? `, ${source.state}` : ""}{source.postalCode ? ` ${source.postalCode}` : ""}<br />
      {source.country} · {source.phone}
      {snapshot?.source === "SAVED" ? <span className="mt-2 block text-xs text-smoke">Saved address version {snapshot.sourceAddressVersion} · reselect after editing to refresh checkout.</span> : null}
    </address>
  );
}
