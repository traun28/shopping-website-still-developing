import "server-only";
import { getFreshUser } from "@/server/auth/session";
import { searchSessionHash } from "@/lib/search/session";
import { guestCartSessionHash, guestCartTokenFromRequest, newGuestCartToken } from "./session";
import type { CartPrincipal } from "@/services/cart/types";

export interface CartRequestIdentity {
  principal: CartPrincipal;
  guestToken: string | null;
  mintedGuestToken: boolean;
}

/** Identity is resolved from the fresh server session and opaque cookie only. */
export async function cartRequestIdentity(
  request: Request,
  options: { createGuestSession?: boolean } = {},
): Promise<CartRequestIdentity> {
  const user = await getFreshUser();
  let guestToken = guestCartTokenFromRequest(request);
  let mintedGuestToken = false;
  if (!user && !guestToken && options.createGuestSession) {
    guestToken = newGuestCartToken();
    mintedGuestToken = true;
  }
  const principal: CartPrincipal = {
    userId: user?.id ?? null,
    guestSessionHash: guestToken ? guestCartSessionHash(guestToken) : null,
    analyticsSessionHash: searchSessionHash({ userId: user?.id ?? null, request }),
  };
  return { principal, guestToken, mintedGuestToken };
}
