import type { CheckoutSession } from "@/db/schema";

export type CheckoutStatus = CheckoutSession["status"];

const transitions: Readonly<Record<CheckoutStatus, ReadonlySet<CheckoutStatus>>> = {
  CREATED: new Set(["VALIDATING", "CANCELLED", "EXPIRED", "FAILED"]),
  VALIDATING: new Set(["NEEDS_ATTENTION", "READY", "FAILED", "EXPIRED", "CANCELLED"]),
  NEEDS_ATTENTION: new Set(["VALIDATING", "CANCELLED", "EXPIRED", "FAILED"]),
  READY: new Set(["VALIDATING", "CANCELLED", "EXPIRED", "FAILED"]),
  PAYMENT_PENDING: new Set(["COMPLETED", "FAILED", "CANCELLED", "EXPIRED"]),
  COMPLETED: new Set(),
  EXPIRED: new Set(),
  CANCELLED: new Set(),
  FAILED: new Set(["VALIDATING", "CANCELLED", "EXPIRED"]),
};

export function canTransitionCheckoutStatus(from: CheckoutStatus, to: CheckoutStatus): boolean {
  return transitions[from].has(to);
}

/** The validating state is part of each persisted transition, even when a single transaction commits the final state. */
export function assertCheckoutTransition(from: CheckoutStatus, to: CheckoutStatus): void {
  if (from === to) return;
  // Mutations persist VALIDATING as an intermediate state before running the
  // same authoritative validator that chooses READY or NEEDS_ATTENTION.
  if (to === "VALIDATING" || from === "VALIDATING") {
    if (!canTransitionCheckoutStatus(from, to)) {
      throw new Error(`Invalid checkout transition: ${from} -> ${to}`);
    }
    return;
  }
  const valid = canTransitionCheckoutStatus(from, "VALIDATING") && canTransitionCheckoutStatus("VALIDATING", to);
  if (!valid) throw new Error(`Invalid checkout transition: ${from} -> ${to}`);
}
