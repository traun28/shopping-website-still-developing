const COUPON_PATTERN = /^[A-Z0-9][A-Z0-9_-]{2,63}$/;

/** Canonical code form; never use raw customer text in logs or audit metadata. */
export function normalizeCouponCode(value: string): string | null {
  const normalized = value.trim().toUpperCase();
  return COUPON_PATTERN.test(normalized) ? normalized : null;
}
