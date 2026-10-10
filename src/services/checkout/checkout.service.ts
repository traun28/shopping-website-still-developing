import "server-only";
import { createHash } from "node:crypto";
import { and, desc, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  addresses,
  carts,
  checkoutMutationKeys,
  checkoutSessions,
  users,
  type Address,
  type CheckoutAddressSnapshot,
  type CheckoutContactSnapshot,
  type CheckoutDeliveryOptionSnapshot,
  type CheckoutIssueSnapshot,
  type CheckoutItemSnapshot,
  type CheckoutSession,
  type CheckoutTotalsSnapshot,
} from "@/db/schema";
import { withTransaction, type DbClient, type DbTx } from "@/db/utils";
import { serverEnv } from "@/config/env";
import { AppError, ConflictError, ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { writeAudit } from "@/services/audit.service";
import { addressValidationService } from "@/services/address-validation.service";
import { getCartSnapshot } from "@/services/cart/cart.service";
import { applyCartPromotions, normalizeCouponCode, previewCouponApplication, reserveCouponForCheckout, releaseCheckoutPromotionReservations, extendCheckoutPromotionReservations, hasActiveCouponReservation, safeCouponError } from "@/services/promotions/promotion.service";
import type { CartPrincipal } from "@/services/cart/types";
import { recordBehavioralEvent } from "@/services/recommendations/events.service";
import { stableAddressInputFromSnapshot } from "./snapshot-utils";
import { deliveryMethodService, type DeliveryOptionResult } from "./delivery-method.service";
import { taxService, type TaxQuote } from "./tax.service";
import { assertCheckoutTransition } from "./state-machine";
import { validateCheckout, type CheckoutAddressState, type CheckoutValidationResult } from "./validator.service";
import type { CheckoutAddressSelectionInput, CheckoutContactInput, CheckoutDeliverySelectionInput, CheckoutRevalidateInput } from "@/validations/checkout";

const ACTIVE_STATUSES: CheckoutSession["status"][] = ["CREATED", "VALIDATING", "NEEDS_ATTENTION", "READY", "FAILED"];
const TERMINAL_STATUSES: CheckoutSession["status"][] = ["EXPIRED", "CANCELLED", "COMPLETED"];
const MUTATION_KEY_RETENTION_DAYS = 7;

export type CheckoutPrincipal = CartPrincipal;

export interface CheckoutSessionDTO {
  id: string;
  status: CheckoutSession["status"];
  version: number;
  cartVersion: number;
  observedCartVersion: number;
  currency: string;
  customerType: "ACCOUNT" | "GUEST";
  appliedCoupon: { code: string; applied: boolean; discountPaise: number } | null;
  appliedPromotions: NonNullable<import("@/types/cart").CartDTO["promotionApplications"]>;
  contact: CheckoutContactSnapshot | null;
  shippingAddress: CheckoutAddressSnapshot | null;
  billingAddress: CheckoutAddressSnapshot | null;
  billingSameAsShipping: boolean;
  delivery: {
    status: "AVAILABLE" | "NOT_CONFIGURED";
    message: string;
    options: CheckoutDeliveryOptionSnapshot[];
    selected: CheckoutDeliveryOptionSnapshot | null;
  };
  items: CheckoutItemSnapshot[];
  fulfillmentGroups: Array<{
    sellerId: string | null;
    sellerName: string;
    itemsCount: number;
    subtotalPaise: number | null;
  }>;
  totals: CheckoutTotalsSnapshot;
  taxMessage: string;
  issues: CheckoutIssueSnapshot[];
  isReady: boolean;
  inventoryReserved: false;
  paymentState: "NOT_STARTED";
  validatedAt: string | null;
  expiresAt: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function contentEqual(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}

function requestHashFor(principal: CheckoutPrincipal, cartId: string): string {
  return sha256(stableJson({
    userId: principal.userId,
    guestHash: principal.userId ? null : principal.guestSessionHash,
    cartId,
  }));
}

function addIssue(issues: CheckoutIssueSnapshot[], issue: CheckoutIssueSnapshot) {
  if (!issues.some((entry) => entry.code === issue.code && entry.itemId === issue.itemId)) issues.push(issue);
}

function sessionOwnerMatches(session: CheckoutSession, principal: CheckoutPrincipal): boolean {
  if (session.userId) return session.userId === principal.userId;
  return Boolean(session.guestSessionHash && principal.guestSessionHash && session.guestSessionHash === principal.guestSessionHash);
}

function accessDenied(): AppError {
  return new AppError("This checkout session could not be accessed.", { status: 403, code: "CHECKOUT_ACCESS_DENIED" });
}

function expiredError(): AppError {
  return new AppError("This checkout session expired. Start checkout again from your cart.", { status: 410, code: "CHECKOUT_EXPIRED" });
}

function sessionTtlMs(): number {
  return serverEnv().CHECKOUT_SESSION_TTL_MINUTES * 60_000;
}

function piiPurgeAt(expiresAt: Date): Date {
  return new Date(expiresAt.getTime() + serverEnv().CHECKOUT_PII_RETENTION_DAYS * 24 * 60 * 60_000);
}

function asCheckoutAddress(row: Address): CheckoutAddressSnapshot {
  return {
    source: "SAVED",
    sourceAddressId: row.id,
    sourceAddressVersion: row.version,
    sourceAddressUpdatedAt: row.updatedAt.toISOString(),
    fullName: row.fullName,
    phone: row.phone,
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2,
    locality: row.locality,
    landmark: row.landmark,
    deliveryInstructions: row.deliveryInstructions,
    city: row.city,
    state: row.state,
    postalCode: row.postalCode,
    country: row.country,
    addressType: row.addressType,
  };
}

function asInlineCheckoutAddress(input: unknown): CheckoutAddressSnapshot {
  const normalized = addressValidationService.validate(input);
  return {
    source: "INLINE",
    sourceAddressId: null,
    sourceAddressVersion: null,
    sourceAddressUpdatedAt: null,
    fullName: normalized.fullName,
    phone: normalized.phone,
    addressLine1: normalized.addressLine1,
    addressLine2: normalized.addressLine2 || null,
    locality: normalized.locality || null,
    landmark: normalized.landmark || null,
    deliveryInstructions: normalized.deliveryInstructions || null,
    city: normalized.city,
    state: normalized.state || null,
    postalCode: normalized.postalCode || null,
    country: normalized.country,
    addressType: normalized.addressType,
  };
}

function addressForValidation(snapshot: CheckoutAddressSnapshot): Record<string, unknown> {
  return stableAddressInputFromSnapshot(snapshot);
}

async function loadSessionRow(sessionId: string, principal: CheckoutPrincipal): Promise<CheckoutSession> {
  const ownerConditions = [];
  if (principal.userId) ownerConditions.push(eq(checkoutSessions.userId, principal.userId));
  if (principal.guestSessionHash) ownerConditions.push(eq(checkoutSessions.guestSessionHash, principal.guestSessionHash));
  if (ownerConditions.length === 0) throw new UnauthorizedError("Start checkout from the current browser session.");

  const [row] = await db.select().from(checkoutSessions)
    .where(and(eq(checkoutSessions.id, sessionId), or(...ownerConditions)))
    .limit(1);
  if (!row) throw accessDenied();
  return row;
}

async function findAccountSessionByKey(userId: string, key: string, client: DbClient = db): Promise<CheckoutSession | null> {
  const [row] = await client
    .select()
    .from(checkoutSessions)
    .where(and(eq(checkoutSessions.userId, userId), eq(checkoutSessions.createIdempotencyKey, key)))
    .limit(1);
  return row ?? null;
}

async function findGuestSessionByKey(guestHash: string, key: string, client: DbClient = db): Promise<CheckoutSession | null> {
  const [row] = await client
    .select()
    .from(checkoutSessions)
    .where(and(eq(checkoutSessions.guestSessionHash, guestHash), eq(checkoutSessions.createIdempotencyKey, key)))
    .limit(1);
  return row ?? null;
}

async function accountContact(userId: string, client: DbClient = db): Promise<CheckoutContactSnapshot | null> {
  const [user] = await client
    .select({ name: users.name, email: users.email, phone: users.phone })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) return null;
  return { name: user.name, email: user.email, phone: user.phone ?? "" };
}

async function claimGuestSession(
  session: CheckoutSession,
  principal: CheckoutPrincipal,
  cartId: string | null,
): Promise<CheckoutSession> {
  if (!principal.userId || !principal.guestSessionHash || session.guestSessionHash !== principal.guestSessionHash) {
    throw accessDenied();
  }
  if (TERMINAL_STATUSES.includes(session.status) || session.expiresAt.getTime() <= Date.now()) {
    throw expiredError();
  }

  const claimed = await withTransaction(async (tx) => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, principal.userId!)).for("update");
    const [current] = await tx.select().from(checkoutSessions).where(eq(checkoutSessions.id, session.id)).for("update");
    if (!current) throw new NotFoundError("Checkout session not found.");
    if (current.userId === principal.userId) return current;
    if (current.userId !== null || current.guestSessionHash !== principal.guestSessionHash) throw accessDenied();
    if (current.expiresAt.getTime() <= Date.now() || TERMINAL_STATUSES.includes(current.status)) throw expiredError();

    const existingAccount = await findAccountSessionByKey(principal.userId!, current.createIdempotencyKey, tx);
    if (existingAccount) {
      const expectedHash = requestHashFor(principal, cartId ?? current.cartId ?? "no-active-cart");
      if (existingAccount.createRequestHash !== expectedHash) {
        throw new ConflictError("This idempotency key was already used for a different cart.", "IDEMPOTENCY_KEY_REUSED");
      }
      return existingAccount;
    }
    const contact = await accountContact(principal.userId!, tx);
    const [updated] = await tx
      .update(checkoutSessions)
      .set({
        userId: principal.userId,
        guestSessionHash: null,
        createRequestHash: requestHashFor(principal, cartId ?? current.cartId ?? "no-active-cart"),
        contactSnapshot: contact ?? current.contactSnapshot,
        status: "VALIDATING",
        version: sql`${checkoutSessions.version} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(checkoutSessions.id, session.id))
      .returning();
    if (!updated) throw new NotFoundError("Checkout session not found.");
    return updated;
  });

  await writeAudit({
    action: "checkout.session_claimed",
    entityType: "checkout",
    entityId: claimed.id,
    actorId: principal.userId,
    metadata: { guestCookieMatched: true, claimedByEmail: false },
  });
  return claimed;
}

async function ownedSession(principal: CheckoutPrincipal, sessionId: string): Promise<CheckoutSession> {
  let session = await loadSessionRow(sessionId, principal);
  if (sessionOwnerMatches(session, principal)) return session;
  if (!session.userId && session.guestSessionHash && principal.userId && principal.guestSessionHash === session.guestSessionHash) {
    const cart = await getCartSnapshot(principal);
    session = await claimGuestSession(session, principal, cart.id);
    if (sessionOwnerMatches(session, principal)) return session;
  }
  throw accessDenied();
}

async function expireSingleSession(session: CheckoutSession, principal: CheckoutPrincipal): Promise<void> {
  const changed = await withTransaction(async (tx) => {
    const [current] = await tx.select().from(checkoutSessions).where(eq(checkoutSessions.id, session.id)).for("update");
    if (!current || !sessionOwnerMatches(current, principal)) throw accessDenied();
    if (TERMINAL_STATUSES.includes(current.status) || current.expiresAt.getTime() > Date.now()) return false;
    await tx.update(checkoutSessions)
      .set({ status: "EXPIRED", version: sql`${checkoutSessions.version} + 1`, updatedAt: new Date() })
      .where(eq(checkoutSessions.id, current.id));
    await releaseCheckoutPromotionReservations(tx, current.id, "CHECKOUT_EXPIRED", current.userId);
    return true;
  });
  if (changed) await emitCheckoutEvent(session, "CHECKOUT_EXPIRED", { status: "EXPIRED" });
}

async function ensureActiveSession(session: CheckoutSession, principal: CheckoutPrincipal): Promise<void> {
  if (session.expiresAt.getTime() <= Date.now() && !TERMINAL_STATUSES.includes(session.status)) {
    await expireSingleSession(session, principal);
    throw expiredError();
  }
  if (session.status === "EXPIRED") throw expiredError();
  if (session.status === "CANCELLED") throw new ConflictError("This checkout session was cancelled.", "CHECKOUT_CANCELLED");
  if (session.status === "COMPLETED") throw new ConflictError("This checkout session is already complete.", "CHECKOUT_COMPLETED");
  if (session.status === "PAYMENT_PENDING") throw new ConflictError("This checkout session is locked by a future payment step.", "CHECKOUT_LOCKED");
}

async function emitCheckoutEvent(
  session: CheckoutSession,
  eventType: string,
  context: Record<string, unknown> = {},
): Promise<void> {
  await recordBehavioralEvent({
    eventType,
    userId: session.userId,
    sessionId: null,
    source: "checkout",
    context: { checkoutSessionId: session.id, ...context },
  });
}

function checkoutDto(session: CheckoutSession, result: CheckoutValidationResult): CheckoutSessionDTO {
  const grouped = new Map<string, { sellerId: string | null; sellerName: string; itemsCount: number; subtotalPaise: number | null; unknown: boolean }>();
  for (const item of result.items) {
    const key = item.sellerId ?? "unknown-seller";
    const group = grouped.get(key) ?? {
      sellerId: item.sellerId,
      sellerName: item.sellerName ?? "Marketplace seller",
      itemsCount: 0,
      subtotalPaise: 0,
      unknown: false,
    };
    group.itemsCount += item.quantity;
    if (item.unitPricePaise === null) group.unknown = true;
    else group.subtotalPaise = (group.subtotalPaise ?? 0) + item.unitPricePaise * item.quantity;
    grouped.set(key, group);
  }

  return {
    id: session.id,
    status: session.status,
    version: session.version,
    cartVersion: session.cartVersion,
    observedCartVersion: result.observedCartVersion,
    currency: session.currency,
    customerType: session.userId ? "ACCOUNT" : "GUEST",
    appliedCoupon: session.couponCode ? {
      code: session.couponCode,
      applied: result.appliedPromotions.some((promotion) => promotion.couponId === session.couponId),
      discountPaise: result.appliedPromotions.filter((promotion) => promotion.couponId === session.couponId).reduce((sum, promotion) => sum + promotion.discountPaise, 0),
    } : null,
    appliedPromotions: result.appliedPromotions,
    contact: session.contactSnapshot,
    shippingAddress: session.shippingAddressSnapshot,
    billingAddress: session.billingSameAsShipping ? session.shippingAddressSnapshot : session.billingAddressSnapshot,
    billingSameAsShipping: session.billingSameAsShipping,
    delivery: {
      status: result.totals.deliveryStatus,
      message: result.deliveryMessage,
      options: result.deliveryOptions,
      selected: result.selectedDelivery,
    },
    items: result.items,
    fulfillmentGroups: [...grouped.values()].map(({ unknown, ...group }) => ({
      ...group,
      subtotalPaise: unknown ? null : group.subtotalPaise,
    })),
    totals: session.totalsSnapshot ?? result.totals,
    taxMessage: result.taxMessage,
    issues: session.validationIssues,
    isReady: session.status === "READY" && session.validationIssues.every((issue) => issue.severity !== "BLOCKING"),
    inventoryReserved: false,
    paymentState: "NOT_STARTED",
    validatedAt: session.validatedAt?.toISOString() ?? null,
    expiresAt: session.expiresAt.toISOString(),
  };
}

async function addressState(
  principal: CheckoutPrincipal,
  snapshot: CheckoutAddressSnapshot | null,
): Promise<CheckoutAddressState> {
  if (!snapshot) return "MISSING";
  try {
    addressValidationService.validate(addressForValidation(snapshot));
  } catch {
    return "INVALID";
  }
  if (snapshot.source !== "SAVED") return "VALID";
  if (!principal.userId || !snapshot.sourceAddressId) return "MISSING";
  const [row] = await db
    .select({ version: addresses.version, updatedAt: addresses.updatedAt })
    .from(addresses)
    .where(and(eq(addresses.id, snapshot.sourceAddressId), eq(addresses.userId, principal.userId)))
    .limit(1);
  if (!row) return "MISSING";
  if (row.version !== snapshot.sourceAddressVersion || row.updatedAt.toISOString() !== snapshot.sourceAddressUpdatedAt) return "CHANGED";
  return "VALID";
}

async function savedAddressIsCurrentForUpdate(
  client: DbClient,
  userId: string | null,
  snapshot: CheckoutAddressSnapshot | null,
): Promise<boolean> {
  if (!snapshot || snapshot.source !== "SAVED") return true;
  if (!userId || !snapshot.sourceAddressId) return false;
  const [row] = await client.select({ version: addresses.version, updatedAt: addresses.updatedAt })
    .from(addresses)
    .where(and(eq(addresses.id, snapshot.sourceAddressId), eq(addresses.userId, userId)))
    .limit(1)
    .for("update");
  return Boolean(row && row.version === snapshot.sourceAddressVersion && row.updatedAt.toISOString() === snapshot.sourceAddressUpdatedAt);
}

async function refreshContact(session: CheckoutSession): Promise<CheckoutContactSnapshot | null> {
  return session.userId ? accountContact(session.userId) : session.contactSnapshot;
}

async function computeValidation(
  principal: CheckoutPrincipal,
  session: CheckoutSession,
  options: { acknowledgeCartChanges?: boolean },
): Promise<{ cart: Awaited<ReturnType<typeof getCartSnapshot>>; result: CheckoutValidationResult; contact: CheckoutContactSnapshot | null }> {
  const [baseCart, contact] = await Promise.all([
    getCartSnapshot(principal, { includePromotions: false }),
    refreshContact(session),
  ]);
  const cart = (await applyCartPromotions(baseCart, { userId: principal.userId, couponCode: session.couponCode, checkoutSessionId: session.id })).cart;
  const shippingAddressState = await addressState(principal, session.shippingAddressSnapshot);
  const billingSnapshot = session.billingSameAsShipping ? session.shippingAddressSnapshot : session.billingAddressSnapshot;
  const billingAddressState = session.billingSameAsShipping
    ? shippingAddressState
    : await addressState(principal, billingSnapshot);
  const items: CheckoutItemSnapshot[] = cart.items.map((line) => ({
    cartItemId: line.id,
    productId: line.productId,
    variantId: line.variantId,
    sellerId: line.sellerId,
    sellerName: line.sellerName,
    productName: line.productName,
    variantName: line.variantName,
    quantity: line.quantity,
    currency: line.currency,
    unitPricePaise: line.unitPricePaise,
    lineSubtotalPaise: line.lineSubtotalPaise,
    lineDiscountPaise: line.lineDiscountPaise,
    estimatedTaxPaise: line.estimatedTaxPaise,
  }));
  const destination = shippingAddressState === "VALID" ? session.shippingAddressSnapshot : null;
  let delivery: DeliveryOptionResult;
  try {
    delivery = await deliveryMethodService.getOptions(
      destination ? { currency: cart.currency, destination, items } : null,
    );
  } catch {
    logger.warn("Checkout delivery integration failed; leaving checkout blocked", { integration: "shipping" });
    delivery = { status: "NOT_CONFIGURED", options: [], message: "Delivery rating is temporarily unavailable." };
  }
  let tax: TaxQuote;
  try {
    tax = await taxService.quote({ currency: cart.currency, destination, cart });
  } catch {
    logger.warn("Checkout tax integration failed; leaving checkout blocked", { integration: "tax" });
    tax = { currency: cart.currency, amountPaise: null, status: "UNAVAILABLE", message: "Destination tax calculation is temporarily unavailable." };
  }

  const effectiveSession: CheckoutSession = {
    ...session,
    contactSnapshot: contact,
    ...(options.acknowledgeCartChanges && cart.id
      ? { cartId: cart.id, cartVersion: cart.version }
      : {}),
  };
  const result = validateCheckout({
    session: effectiveSession,
    cart,
    shippingAddressState,
    billingAddressState,
    delivery,
    tax,
    acknowledgeCartChanges: options.acknowledgeCartChanges,
  });
  return { cart, result, contact };
}

async function persistValidation(
  principal: CheckoutPrincipal,
  originalSession: CheckoutSession,
  cart: Awaited<ReturnType<typeof getCartSnapshot>>,
  result: CheckoutValidationResult,
  contact: CheckoutContactSnapshot | null,
  acknowledgeCartChanges: boolean,
): Promise<{ session: CheckoutSession; stale: boolean }> {
  const now = new Date();
  const saved = await withTransaction(async (tx) => {
    const [current] = await tx.select().from(checkoutSessions).where(eq(checkoutSessions.id, originalSession.id)).for("update");
    if (!current || !sessionOwnerMatches(current, principal)) throw accessDenied();
    if (current.version !== originalSession.version) return { session: current, stale: true };
    if (current.expiresAt.getTime() <= now.getTime()) return { session: current, stale: false, expired: true };

    const issues = [...result.issues];
    const shippingAddressStable = await savedAddressIsCurrentForUpdate(tx, principal.userId, current.shippingAddressSnapshot);
    if (!shippingAddressStable) {
      addIssue(issues, {
        code: "SHIPPING_ADDRESS_CHANGED",
        severity: "BLOCKING",
        message: "The saved shipping address changed during validation. Review and select it again.",
      });
    }
    if (!current.billingSameAsShipping) {
      const billingAddressStable = await savedAddressIsCurrentForUpdate(tx, principal.userId, current.billingAddressSnapshot);
      if (!billingAddressStable) {
        addIssue(issues, {
          code: "BILLING_ADDRESS_CHANGED",
          severity: "BLOCKING",
          message: "The saved billing address changed during validation. Review and select it again.",
        });
      }
    }

    let cartStable = true;
    if (cart.id) {
      const [currentCart] = await tx.select({ version: carts.version, status: carts.status }).from(carts).where(eq(carts.id, cart.id)).for("update");
      cartStable = Boolean(currentCart && currentCart.status === "ACTIVE" && currentCart.version === cart.version);
      if (!cartStable) {
        addIssue(issues, {
          code: "CART_CHANGED",
          severity: "BLOCKING",
          message: "The cart changed while checkout was being validated. Review and recheck it.",
        });
      }
    } else {
      cartStable = false;
    }

    if (current.couponId) {
      const reservationActive = await hasActiveCouponReservation(tx, current.id, current.couponId, now);
      const cartOrCouponInvalid = issues.some((issue) => issue.code === "CART_CHANGED" || issue.code === "COUPON_UNAVAILABLE");
      if (!reservationActive || cartOrCouponInvalid) {
        if (!cartOrCouponInvalid) {
          addIssue(issues, {
            code: "COUPON_RESERVATION_REQUIRED",
            severity: "BLOCKING",
            message: "Reapply this coupon after reviewing your current cart to reserve its limited capacity.",
          });
        } else if (issues.some((issue) => issue.code === "CART_CHANGED") && !issues.some((issue) => issue.code === "COUPON_UNAVAILABLE")) {
          addIssue(issues, {
            code: "COUPON_RESERVATION_REQUIRED",
            severity: "BLOCKING",
            message: "Reapply this coupon after reviewing your current cart to reserve its limited capacity.",
          });
        }
        await releaseCheckoutPromotionReservations(tx, current.id, cartOrCouponInvalid ? "REVALIDATION_FAILED" : "RESERVATION_MISSING", current.userId);
      }
    }

    const nextStatus: CheckoutSession["status"] = issues.some((issue) => issue.severity === "BLOCKING") ? "NEEDS_ATTENTION" : "READY";
    assertCheckoutTransition(current.status, nextStatus);
    const canAcknowledge = acknowledgeCartChanges && cartStable && Boolean(cart.id);
    const nextCartId = canAcknowledge ? cart.id : current.cartId;
    const nextCartVersion = canAcknowledge ? cart.version : current.cartVersion;
    const items = result.items;
    const totals = result.totals;
    const changed = current.status !== nextStatus || current.cartId !== nextCartId || current.cartVersion !== nextCartVersion ||
      !contentEqual(current.contactSnapshot, contact) || !contentEqual(current.itemsSnapshot, items) ||
      !contentEqual(current.totalsSnapshot, totals) || !contentEqual(current.validationIssues, issues) ||
      !contentEqual(current.selectedDeliverySnapshot, result.selectedDelivery);
    const nextVersion = changed ? current.version + 1 : current.version;
    const [updated] = await tx
      .update(checkoutSessions)
      .set({
        status: nextStatus,
        version: nextVersion,
        cartId: nextCartId,
        cartVersion: nextCartVersion,
        currency: cart.currency,
        contactSnapshot: contact,
        itemsSnapshot: items,
        totalsSnapshot: totals,
        validationIssues: issues,
        selectedDeliverySnapshot: result.selectedDelivery,
        selectedDeliveryMethodId: result.selectedDelivery?.id ?? null,
        validatedAt: now,
        updatedAt: now,
      })
      .where(eq(checkoutSessions.id, current.id))
      .returning();
    if (!updated) throw new NotFoundError("Checkout session not found.");
    return { session: updated, stale: false, expired: false };
  });

  if (saved.stale) return { session: saved.session, stale: true };
  if (saved.expired) {
    await expireSingleSession(saved.session, principal);
    throw expiredError();
  }
  if (saved.session.status !== originalSession.status) {
    const event = saved.session.status === "READY" ? "CHECKOUT_READY" : "CHECKOUT_NEEDS_ATTENTION";
    await emitCheckoutEvent(saved.session, event, {
      status: saved.session.status,
      issueCodes: saved.session.validationIssues.map((issue) => issue.code),
    });
    await writeAudit({
      action: `checkout.status_${saved.session.status.toLowerCase()}`,
      entityType: "checkout",
      entityId: saved.session.id,
      actorId: saved.session.userId ?? undefined,
      metadata: { version: saved.session.version, issueCodes: saved.session.validationIssues.map((issue) => issue.code) },
    });
  }
  return { session: saved.session, stale: false };
}

async function validateAndPersist(
  principal: CheckoutPrincipal,
  sessionId: string,
  options: { acknowledgeCartChanges?: boolean } = {},
): Promise<CheckoutSessionDTO> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const session = await ownedSession(principal, sessionId);
    await ensureActiveSession(session, principal);
    const computed = await computeValidation(principal, session, options);
    const persisted = await persistValidation(principal, session, computed.cart, computed.result, computed.contact, Boolean(options.acknowledgeCartChanges));
    if (!persisted.stale) return checkoutDto(persisted.session, computed.result);
  }
  throw new ConflictError("Checkout changed during validation. Refresh and try again.", "CHECKOUT_VERSION_CONFLICT");
}

async function createSessionRow(
  principal: CheckoutPrincipal,
  cart: Awaited<ReturnType<typeof getCartSnapshot>>,
  key: string,
): Promise<{ session: CheckoutSession; created: boolean }> {
  if (!cart.id) throw new ConflictError("Your cart is empty. Add an item before checking out.", "CART_EMPTY");
  if (!principal.userId && !principal.guestSessionHash) throw new UnauthorizedError("Start checkout from the current browser session.");

  const createRequestHash = requestHashFor(principal, cart.id);
  if (principal.userId) {
    const accountExisting = await findAccountSessionByKey(principal.userId, key);
    if (accountExisting) {
      if (accountExisting.createRequestHash !== createRequestHash) throw new ConflictError("This idempotency key was already used for a different cart.", "IDEMPOTENCY_KEY_REUSED");
      return { session: accountExisting, created: false };
    }
    if (principal.guestSessionHash) {
      const guestExisting = await findGuestSessionByKey(principal.guestSessionHash, key);
      if (guestExisting) {
        const claimed = await claimGuestSession(guestExisting, principal, cart.id);
        return { session: claimed, created: false };
      }
    }
  } else if (principal.guestSessionHash) {
    const guestExisting = await findGuestSessionByKey(principal.guestSessionHash, key);
    if (guestExisting) {
      if (guestExisting.createRequestHash !== createRequestHash) throw new ConflictError("This idempotency key was already used for a different cart.", "IDEMPOTENCY_KEY_REUSED");
      return { session: guestExisting, created: false };
    }
  }

  if (cart.items.length === 0) throw new ConflictError("Your cart is empty. Add an item before checking out.", "CART_EMPTY");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + sessionTtlMs());
  const contact = principal.userId ? await accountContact(principal.userId) : null;
  const ownerAddresses = principal.userId
    ? await db.select().from(addresses).where(eq(addresses.userId, principal.userId)).orderBy(desc(addresses.isDefault), desc(addresses.isDefaultBilling))
    : [];
  const shipping = ownerAddresses.find((address) => address.isDefault) ?? null;
  const billing = ownerAddresses.find((address) => address.isDefaultBilling) ?? null;
  const billingSameAsShipping = !billing || billing.id === shipping?.id;

  const inserted = await withTransaction(async (tx) => {
    const [row] = await tx
      .insert(checkoutSessions)
      .values({
        userId: principal.userId,
        guestSessionHash: principal.userId ? null : principal.guestSessionHash,
        cartId: cart.id,
        createIdempotencyKey: key,
        createRequestHash,
        status: "CREATED",
        version: 1,
        cartVersion: cart.version,
        currency: cart.currency,
        contactSnapshot: contact,
        shippingAddressId: shipping?.id ?? null,
        shippingAddressSnapshot: shipping ? asCheckoutAddress(shipping) : null,
        billingAddressId: billingSameAsShipping ? null : billing?.id ?? null,
        billingAddressSnapshot: billingSameAsShipping || !billing ? null : asCheckoutAddress(billing),
        billingSameAsShipping,
        itemsSnapshot: [],
        validationIssues: [],
        expiresAt,
        piiPurgeAt: piiPurgeAt(expiresAt),
      })
      .onConflictDoNothing()
      .returning();
    if (row) return { session: row, created: true };
    const existing = principal.userId
      ? await findAccountSessionByKey(principal.userId, key, tx)
      : principal.guestSessionHash
        ? await findGuestSessionByKey(principal.guestSessionHash, key, tx)
        : null;
    if (!existing) throw new ConflictError("Checkout could not be started. Refresh your cart and retry.", "CHECKOUT_CREATE_CONFLICT");
    if (existing.createRequestHash !== createRequestHash) throw new ConflictError("This idempotency key was already used for a different cart.", "IDEMPOTENCY_KEY_REUSED");
    return { session: existing, created: false };
  });

  if (inserted.created) {
    await emitCheckoutEvent(inserted.session, "CHECKOUT_STARTED", { cartVersion: inserted.session.cartVersion });
    await writeAudit({
      action: "checkout.session_created",
      entityType: "checkout",
      entityId: inserted.session.id,
      actorId: inserted.session.userId ?? undefined,
      metadata: { ownerType: inserted.session.userId ? "ACCOUNT" : "GUEST", version: inserted.session.version },
    });
  }
  return inserted;
}

export async function createOrResumeCheckoutSession(
  principal: CheckoutPrincipal,
  idempotencyKey: string,
): Promise<CheckoutSessionDTO> {
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) throw new ValidationError("A valid Idempotency-Key header is required.");
  if (!principal.userId && !principal.guestSessionHash) throw new UnauthorizedError("Start checkout from the current browser session.");
  const cart = await getCartSnapshot(principal);
  const { session } = await createSessionRow(principal, cart, idempotencyKey);
  return validateAndPersist(principal, session.id);
}

interface BeginMutationResult {
  session: CheckoutSession;
  replayed: boolean;
}

async function beginMutation(
  principal: CheckoutPrincipal,
  sessionId: string,
  input: {
    key: string;
    operation: string;
    expectedVersion: number;
    payload: unknown;
    update: (current: CheckoutSession, tx: DbTx) => Partial<CheckoutSession> | Promise<Partial<CheckoutSession>>;
  },
): Promise<BeginMutationResult> {
  const initial = await ownedSession(principal, sessionId);
  await ensureActiveSession(initial, principal);
  const payloadHash = sha256(stableJson({ expectedVersion: input.expectedVersion, payload: input.payload }));
  const result = await withTransaction(async (tx) => {
    const [current] = await tx.select().from(checkoutSessions).where(eq(checkoutSessions.id, sessionId)).for("update");
    if (!current || !sessionOwnerMatches(current, principal)) throw accessDenied();
    if (current.expiresAt.getTime() <= Date.now()) return { session: current, expired: true, replayed: false };

    const [prior] = await tx.select().from(checkoutMutationKeys)
      .where(and(eq(checkoutMutationKeys.checkoutSessionId, sessionId), eq(checkoutMutationKeys.key, input.key)))
      .limit(1);
    if (prior) {
      if (prior.operation !== input.operation || prior.payloadHash !== payloadHash) {
        throw new ConflictError("This idempotency key was already used for a different checkout change.", "IDEMPOTENCY_KEY_REUSED");
      }
      return { session: current, expired: false, replayed: true };
    }
    if (current.version !== input.expectedVersion) {
      throw new ConflictError("Checkout changed in another tab. Refresh and review the latest details.", "CHECKOUT_VERSION_CONFLICT");
    }
    if (!ACTIVE_STATUSES.includes(current.status)) throw new ConflictError("This checkout session can no longer be changed.", "CHECKOUT_STATE_CONFLICT");
    assertCheckoutTransition(current.status, "VALIDATING");
    const patch = await input.update(current, tx);
    const expiresAt = new Date(Date.now() + sessionTtlMs());
    const [updated] = await tx.update(checkoutSessions)
      .set({
        ...patch,
        status: "VALIDATING",
        version: sql`${checkoutSessions.version} + 1`,
        expiresAt,
        piiPurgeAt: piiPurgeAt(expiresAt),
        updatedAt: new Date(),
      })
      .where(eq(checkoutSessions.id, current.id))
      .returning();
    if (!updated) throw new NotFoundError("Checkout session not found.");
    await extendCheckoutPromotionReservations(tx, updated.id, updated.expiresAt);
    await tx.insert(checkoutMutationKeys).values({
      checkoutSessionId: sessionId,
      key: input.key,
      operation: input.operation,
      payloadHash,
      expiresAt: new Date(Date.now() + MUTATION_KEY_RETENTION_DAYS * 24 * 60 * 60_000),
    });
    return { session: updated, expired: false, replayed: false };
  });
  if (result.expired) {
    await expireSingleSession(result.session, principal);
    throw expiredError();
  }
  return { session: result.session, replayed: result.replayed };
}

async function preparedAddress(
  principal: CheckoutPrincipal,
  id: string | null | undefined,
  inline: unknown,
): Promise<{ id: string | null; snapshot: CheckoutAddressSnapshot | null } | null> {
  if (id !== undefined) {
    if (id === null) return { id: null, snapshot: null };
    if (!principal.userId) throw new ForbiddenError("Guest checkout cannot select an account address.");
    const [row] = await db.select().from(addresses)
      .where(and(eq(addresses.id, id), eq(addresses.userId, principal.userId)))
      .limit(1);
    if (!row) throw new NotFoundError("Address not found.");
    return { id: row.id, snapshot: asCheckoutAddress(row) };
  }
  if (inline !== undefined) return { id: null, snapshot: asInlineCheckoutAddress(inline) };
  return null;
}

export async function updateCheckoutContact(
  principal: CheckoutPrincipal,
  sessionId: string,
  input: CheckoutContactInput,
  options: { expectedVersion: number; idempotencyKey: string },
): Promise<CheckoutSessionDTO> {
  const before = await ownedSession(principal, sessionId);
  if (before.userId) throw new ForbiddenError("Account contact details are managed in your profile.");
  const mutation = await beginMutation(principal, sessionId, {
    key: options.idempotencyKey,
    operation: "contact",
    expectedVersion: options.expectedVersion,
    payload: input,
    update: () => ({ contactSnapshot: input }),
  });
  if (mutation.replayed) return validateAndPersist(principal, sessionId);
  await writeAudit({
    action: "checkout.contact_updated",
    entityType: "checkout",
    entityId: sessionId,
    metadata: { version: mutation.session.version, guest: true, contactContentsLogged: false },
  });
  return validateAndPersist(principal, sessionId);
}

export async function applyCheckoutCoupon(
  principal: CheckoutPrincipal,
  sessionId: string,
  input: { expectedVersion: number; code: string },
  options: { idempotencyKey: string },
): Promise<CheckoutSessionDTO> {
  const session = await ownedSession(principal, sessionId);
  await ensureActiveSession(session, principal);
  const normalizedCode = normalizeCouponCode(input.code);
  if (!normalizedCode) throw new ConflictError(safeCouponError(), "COUPON_UNAVAILABLE");
  const cart = await getCartSnapshot(principal, { includePromotions: false });
  const preview = await previewCouponApplication({ cart, userId: principal.userId, code: normalizedCode, checkoutSessionId: sessionId });
  if (!preview.valid || !preview.coupon || !preview.candidate || !preview.allocation) {
    throw new ConflictError(safeCouponError(), "COUPON_UNAVAILABLE");
  }
  const allocationSnapshots = Object.entries(preview.allocation.lineAllocations).map(([cartItemId, amountPaise]) => ({
    cartItemId,
    productId: cart.items.find((item) => item.id === cartItemId)?.productId ?? "",
    amountPaise,
  })).filter((allocation) => allocation.productId);
  if (allocationSnapshots.reduce((sum, allocation) => sum + allocation.amountPaise, 0) !== preview.discountPaise) {
    throw new ConflictError("The cart changed while the coupon was being applied. Review the cart and retry.", "CART_CHANGED");
  }

  const mutation = await beginMutation(principal, sessionId, {
    key: options.idempotencyKey,
    operation: "coupon_apply",
    expectedVersion: input.expectedVersion,
    payload: { couponId: preview.couponId, code: normalizedCode },
    update: async (current, tx) => {
      await reserveCouponForCheckout(tx, {
        couponId: preview.couponId!,
        promotionId: preview.promotionId!,
        expectedPromotionVersion: preview.candidate!.version,
        expectedCouponCode: normalizedCode,
        checkoutSessionId: current.id,
        expectedCartId: cart.id,
        expectedCartVersion: cart.version,
        userId: current.userId,
        idempotencyKey: sha256(`coupon:${current.id}:${options.idempotencyKey}`),
        discountPaise: preview.discountPaise,
        currency: cart.currency,
        allocations: allocationSnapshots,
        expiresAt: current.expiresAt,
        actorId: current.userId,
      });
      return { couponId: preview.couponId, couponCode: normalizedCode };
    },
  });
  if (!mutation.replayed) {
    await emitCheckoutEvent(mutation.session, "CHECKOUT_COUPON_APPLIED", { couponId: preview.couponId, discountPaise: preview.discountPaise });
    await writeAudit({ action: "checkout.coupon_applied", entityType: "checkout", entityId: sessionId, actorId: mutation.session.userId ?? undefined, metadata: { couponId: preview.couponId, discountPaise: preview.discountPaise, codeLogged: false } });
  }
  return validateAndPersist(principal, sessionId);
}

export async function removeCheckoutCoupon(
  principal: CheckoutPrincipal,
  sessionId: string,
  input: { expectedVersion: number },
  options: { idempotencyKey: string },
): Promise<CheckoutSessionDTO> {
  const mutation = await beginMutation(principal, sessionId, {
    key: options.idempotencyKey,
    operation: "coupon_remove",
    expectedVersion: input.expectedVersion,
    payload: input,
    update: async (current, tx) => {
      await releaseCheckoutPromotionReservations(tx, current.id, "COUPON_REMOVED", current.userId);
      return { couponId: null, couponCode: null };
    },
  });
  if (mutation.replayed) return validateAndPersist(principal, sessionId);
  await emitCheckoutEvent(mutation.session, "CHECKOUT_COUPON_REMOVED", { couponIdRemoved: true });
  await writeAudit({ action: "checkout.coupon_removed", entityType: "checkout", entityId: sessionId, actorId: mutation.session.userId ?? undefined, metadata: { codeLogged: false } });
  return validateAndPersist(principal, sessionId);
}

export async function updateCheckoutAddresses(
  principal: CheckoutPrincipal,
  sessionId: string,
  input: CheckoutAddressSelectionInput,
  options: { idempotencyKey: string },
): Promise<CheckoutSessionDTO> {
  const shipping = await preparedAddress(principal, input.shippingAddressId, input.shippingAddress);
  const billing = input.billingSameAsShipping
    ? { id: null, snapshot: null }
    : await preparedAddress(principal, input.billingAddressId, input.billingAddress);
  const mutation = await beginMutation(principal, sessionId, {
    key: options.idempotencyKey,
    operation: "addresses",
    expectedVersion: input.expectedVersion,
    payload: input,
    update: (current) => ({
      shippingAddressId: shipping?.id ?? current.shippingAddressId,
      shippingAddressSnapshot: shipping?.snapshot ?? current.shippingAddressSnapshot,
      ...(shipping && !shipping.snapshot ? { shippingAddressId: null, shippingAddressSnapshot: null } : {}),
      billingAddressId: input.billingSameAsShipping ? null : billing?.id ?? current.billingAddressId,
      billingAddressSnapshot: input.billingSameAsShipping ? null : billing?.snapshot ?? current.billingAddressSnapshot,
      ...(billing && !billing.snapshot && !input.billingSameAsShipping ? { billingAddressId: null, billingAddressSnapshot: null } : {}),
      billingSameAsShipping: input.billingSameAsShipping,
    }),
  });
  if (mutation.replayed) return validateAndPersist(principal, sessionId);
  await emitCheckoutEvent(mutation.session, "CHECKOUT_ADDRESS_SELECTED", {
    shippingSource: shipping?.snapshot?.source ?? "UNCHANGED",
    billingSameAsShipping: input.billingSameAsShipping,
  });
  await writeAudit({
    action: "checkout.address_selected",
    entityType: "checkout",
    entityId: sessionId,
    actorId: mutation.session.userId ?? undefined,
    metadata: { version: mutation.session.version, addressContentsLogged: false, billingSameAsShipping: input.billingSameAsShipping },
  });
  return validateAndPersist(principal, sessionId);
}

export async function selectCheckoutDelivery(
  principal: CheckoutPrincipal,
  sessionId: string,
  input: CheckoutDeliverySelectionInput,
  options: { idempotencyKey: string },
): Promise<CheckoutSessionDTO> {
  const session = await ownedSession(principal, sessionId);
  await ensureActiveSession(session, principal);
  const cart = await getCartSnapshot(principal);
  const shippingState = await addressState(principal, session.shippingAddressSnapshot);
  const items = cart.items.map((line) => ({
    cartItemId: line.id,
    productId: line.productId,
    variantId: line.variantId,
    sellerId: line.sellerId,
    sellerName: line.sellerName,
    productName: line.productName,
    variantName: line.variantName,
    quantity: line.quantity,
    currency: line.currency,
    unitPricePaise: line.unitPricePaise,
    lineSubtotalPaise: line.lineSubtotalPaise,
    lineDiscountPaise: line.lineDiscountPaise,
    estimatedTaxPaise: line.estimatedTaxPaise,
  }));
  const optionsResult = await deliveryMethodService.getOptions(
    shippingState === "VALID" && session.shippingAddressSnapshot
      ? { currency: cart.currency, destination: session.shippingAddressSnapshot, items }
      : null,
  );
  const selected = optionsResult.options.find((option) => option.id === input.deliveryMethodId);
  if (!selected) throw new ConflictError(optionsResult.message, "DELIVERY_UNAVAILABLE");

  const mutation = await beginMutation(principal, sessionId, {
    key: options.idempotencyKey,
    operation: "delivery",
    expectedVersion: input.expectedVersion,
    payload: input,
    update: () => ({ selectedDeliveryMethodId: selected.id, selectedDeliverySnapshot: selected }),
  });
  if (mutation.replayed) return validateAndPersist(principal, sessionId);
  await emitCheckoutEvent(mutation.session, "CHECKOUT_DELIVERY_SELECTED", { methodId: selected.id });
  await writeAudit({
    action: "checkout.delivery_selected",
    entityType: "checkout",
    entityId: sessionId,
    actorId: mutation.session.userId ?? undefined,
    metadata: { version: mutation.session.version, methodId: selected.id, amountPaise: selected.amountPaise },
  });
  return validateAndPersist(principal, sessionId);
}

export async function revalidateCheckoutSession(
  principal: CheckoutPrincipal,
  sessionId: string,
  input: CheckoutRevalidateInput,
  options: { idempotencyKey: string },
): Promise<CheckoutSessionDTO> {
  const mutation = await beginMutation(principal, sessionId, {
    key: options.idempotencyKey,
    operation: "revalidate",
    expectedVersion: input.expectedVersion,
    payload: input,
    update: () => ({}),
  });
  if (mutation.replayed) return validateAndPersist(principal, sessionId);
  await emitCheckoutEvent(mutation.session, "CHECKOUT_REVALIDATED", {
    acknowledgeCartChanges: input.acknowledgeCartChanges,
    version: mutation.session.version,
  });
  return validateAndPersist(principal, sessionId, { acknowledgeCartChanges: input.acknowledgeCartChanges });
}

export async function getCheckoutSessionSummary(
  principal: CheckoutPrincipal,
  sessionId: string,
): Promise<CheckoutSessionDTO> {
  return validateAndPersist(principal, sessionId);
}

export async function getCheckoutDeliveryOptions(
  principal: CheckoutPrincipal,
  sessionId: string,
): Promise<CheckoutSessionDTO["delivery"]> {
  const summary = await getCheckoutSessionSummary(principal, sessionId);
  return summary.delivery;
}

export async function cancelCheckoutSession(
  principal: CheckoutPrincipal,
  sessionId: string,
  input: { expectedVersion: number },
  options: { idempotencyKey: string },
): Promise<{ id: string; status: "CANCELLED"; version: number }> {
  const payloadHash = sha256(stableJson({ expectedVersion: input.expectedVersion, payload: input }));
  const result = await withTransaction(async (tx) => {
    const [current] = await tx.select().from(checkoutSessions).where(eq(checkoutSessions.id, sessionId)).for("update");
    if (!current || !sessionOwnerMatches(current, principal)) throw accessDenied();
    if (current.expiresAt.getTime() <= Date.now()) return { session: current, expired: true, replayed: false };
    const [prior] = await tx.select().from(checkoutMutationKeys)
      .where(and(eq(checkoutMutationKeys.checkoutSessionId, sessionId), eq(checkoutMutationKeys.key, options.idempotencyKey)))
      .limit(1);
    if (prior) {
      if (prior.operation !== "cancel" || prior.payloadHash !== payloadHash) throw new ConflictError("This idempotency key was already used for a different checkout change.", "IDEMPOTENCY_KEY_REUSED");
      return { session: current, expired: false, replayed: true };
    }
    if (current.version !== input.expectedVersion) throw new ConflictError("Checkout changed in another tab. Refresh and review the latest details.", "CHECKOUT_VERSION_CONFLICT");
    if (!ACTIVE_STATUSES.includes(current.status)) throw new ConflictError("This checkout session can no longer be cancelled.", "CHECKOUT_STATE_CONFLICT");
    assertCheckoutTransition(current.status, "CANCELLED");
    const [updated] = await tx.update(checkoutSessions)
      .set({ status: "CANCELLED", version: sql`${checkoutSessions.version} + 1`, updatedAt: new Date() })
      .where(eq(checkoutSessions.id, sessionId))
      .returning();
    await tx.insert(checkoutMutationKeys).values({
      checkoutSessionId: sessionId,
      key: options.idempotencyKey,
      operation: "cancel",
      payloadHash,
      expiresAt: new Date(Date.now() + MUTATION_KEY_RETENTION_DAYS * 24 * 60 * 60_000),
    });
    if (!updated) throw new NotFoundError("Checkout session not found.");
    await releaseCheckoutPromotionReservations(tx, current.id, "CHECKOUT_CANCELLED", current.userId);
    return { session: updated, expired: false, replayed: false };
  });
  if (result.expired) {
    await expireSingleSession(result.session, principal);
    throw expiredError();
  }
  if (!result.replayed) {
    await emitCheckoutEvent(result.session, "CHECKOUT_CANCELLED", { version: result.session.version });
    await writeAudit({ action: "checkout.cancelled", entityType: "checkout", entityId: sessionId, actorId: result.session.userId ?? undefined, metadata: { version: result.session.version } });
  }
  return { id: result.session.id, status: "CANCELLED", version: result.session.version };
}

/** Expire sessions and prune idempotency metadata; retain session history and clear PII on schedule. */
export async function runCheckoutMaintenance(now = new Date(), batchSize = 500): Promise<{ expired: number; piiPurged: number; idempotencyKeysDeleted: number }> {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5_000) throw new ValidationError("Checkout maintenance batch size must be between 1 and 5000.");
  const expiredRows = await withTransaction(async (tx) => {
    const candidates = await tx.select({ id: checkoutSessions.id }).from(checkoutSessions)
      .where(and(inArray(checkoutSessions.status, ACTIVE_STATUSES), lte(checkoutSessions.expiresAt, now)))
      .limit(batchSize);
    if (!candidates.length) return [];
    const expired = await tx.update(checkoutSessions)
      .set({ status: "EXPIRED", version: sql`${checkoutSessions.version} + 1`, updatedAt: now })
      .where(and(
        inArray(checkoutSessions.id, candidates.map((row) => row.id)),
        inArray(checkoutSessions.status, ACTIVE_STATUSES),
        lte(checkoutSessions.expiresAt, now),
      ))
      .returning({ id: checkoutSessions.id, userId: checkoutSessions.userId, version: checkoutSessions.version });
    for (const session of expired) await releaseCheckoutPromotionReservations(tx, session.id, "CHECKOUT_EXPIRED", session.userId);
    return expired;
  });
  for (const row of expiredRows) {
    await recordBehavioralEvent({
      eventType: "CHECKOUT_EXPIRED",
      userId: row.userId,
      source: "checkout-maintenance",
      context: { checkoutSessionId: row.id, version: row.version },
    });
    await writeAudit({ action: "checkout.expired", entityType: "checkout", entityId: row.id, actorId: row.userId ?? undefined, metadata: { version: row.version, source: "maintenance" } });
  }

  const purgedRows = await withTransaction(async (tx) => {
    const candidates = await tx.select({ id: checkoutSessions.id }).from(checkoutSessions)
      .where(and(
        inArray(checkoutSessions.status, ["EXPIRED", "CANCELLED", "FAILED", "COMPLETED"]),
        lte(checkoutSessions.piiPurgeAt, now),
        isNull(checkoutSessions.piiPurgedAt),
      ))
      .limit(batchSize);
    if (!candidates.length) return [];
    return tx.update(checkoutSessions)
      .set({
        contactSnapshot: null,
        shippingAddressId: null,
        shippingAddressSnapshot: null,
        billingAddressId: null,
        billingAddressSnapshot: null,
        guestSessionHash: null,
        piiPurgedAt: now,
        version: sql`${checkoutSessions.version} + 1`,
        updatedAt: now,
      })
      .where(and(
        inArray(checkoutSessions.id, candidates.map((row) => row.id)),
        inArray(checkoutSessions.status, ["EXPIRED", "CANCELLED", "FAILED", "COMPLETED"]),
        lte(checkoutSessions.piiPurgeAt, now),
        isNull(checkoutSessions.piiPurgedAt),
      ))
      .returning({ id: checkoutSessions.id });
  });

  const deletedKeys = await withTransaction(async (tx) => {
    const candidates = await tx.select({ id: checkoutMutationKeys.id }).from(checkoutMutationKeys)
      .where(lte(checkoutMutationKeys.expiresAt, now)).limit(batchSize);
    if (!candidates.length) return [];
    return tx.delete(checkoutMutationKeys)
      .where(and(inArray(checkoutMutationKeys.id, candidates.map((row) => row.id)), lte(checkoutMutationKeys.expiresAt, now)))
      .returning({ id: checkoutMutationKeys.id });
  });

  return { expired: expiredRows.length, piiPurged: purgedRows.length, idempotencyKeysDeleted: deletedKeys.length };
}

/** Admin-only aggregate diagnostics: no address, contact, or customer-owned snapshot data. */
export async function getAdminCheckoutMetrics(): Promise<{
  total30Days: number;
  active: number;
  ready: number;
  needsAttention: number;
  expired30Days: number;
  piiPurged30Days: number;
  blockingIssueCounts: Array<{ code: string; count: number }>;
  recentTransitions: Array<{ id: string; status: CheckoutSession["status"]; version: number; updatedAt: Date; issueCodes: string[] }>;
}> {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60_000);
  const [statusRows, issueResult, [piiCount], recentRows] = await Promise.all([
    db.select({ status: checkoutSessions.status, count: sql<number>`count(*)::int` })
      .from(checkoutSessions).where(gte(checkoutSessions.createdAt, cutoff)).groupBy(checkoutSessions.status),
    db.execute<{ code: string; count: number }>(sql`
      SELECT issue->>'code' AS code, count(*)::int AS count
      FROM checkout_sessions AS session
      CROSS JOIN LATERAL jsonb_array_elements(session.validation_issues) AS issue
      WHERE session.created_at >= ${cutoff} AND issue->>'severity' = 'BLOCKING'
      GROUP BY issue->>'code'
      ORDER BY count(*) DESC
    `),
    db.select({ count: sql<number>`count(*)::int` }).from(checkoutSessions)
      .where(and(gte(checkoutSessions.createdAt, cutoff), isNotNull(checkoutSessions.piiPurgedAt))),
    db.select({
      id: checkoutSessions.id,
      status: checkoutSessions.status,
      version: checkoutSessions.version,
      updatedAt: checkoutSessions.updatedAt,
      validationIssues: checkoutSessions.validationIssues,
    }).from(checkoutSessions).where(gte(checkoutSessions.createdAt, cutoff))
      .orderBy(desc(checkoutSessions.updatedAt)).limit(50),
  ]);
  const counts = new Map(statusRows.map((row) => [row.status, Number(row.count)]));
  const total30Days = statusRows.reduce((sum, row) => sum + Number(row.count), 0);
  const active = ACTIVE_STATUSES.filter((status) => status !== "FAILED")
    .reduce((sum, status) => sum + (counts.get(status) ?? 0), counts.get("FAILED") ?? 0);
  return {
    total30Days,
    active,
    ready: counts.get("READY") ?? 0,
    needsAttention: counts.get("NEEDS_ATTENTION") ?? 0,
    expired30Days: counts.get("EXPIRED") ?? 0,
    piiPurged30Days: Number(piiCount?.count ?? 0),
    blockingIssueCounts: issueResult.rows.map((row) => ({ code: row.code, count: Number(row.count) })),
    recentTransitions: recentRows.map((row) => ({
      id: row.id,
      status: row.status,
      version: row.version,
      updatedAt: row.updatedAt,
      issueCodes: (row.validationIssues ?? []).map((issue) => issue.code),
    })),
  };
}
