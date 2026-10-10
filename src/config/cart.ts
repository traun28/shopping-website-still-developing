import "server-only";
import { serverEnv } from "@/config/env";

/** Server-side retention and abandonment policy. No marketing action is implied. */
export function cartPolicy() {
  const env = serverEnv();
  return {
    guestTtlMs: env.CART_GUEST_TTL_DAYS * 86_400_000,
    userTtlMs: env.CART_USER_TTL_DAYS * 86_400_000,
    abandonmentMs: env.CART_ABANDONMENT_MINUTES * 60_000,
    idempotencyTtlMs: 30 * 86_400_000,
  } as const;
}
