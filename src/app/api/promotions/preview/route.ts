import { z } from "zod";
import { apiOk, withErrorHandling } from "@/lib/api-response";
import { RateLimitError } from "@/lib/errors";
import { clientIp, createRateLimiter } from "@/lib/rate-limit";
import { assertSameOriginJsonMutation } from "@/server/cart/session";
import { cartRequestIdentity } from "@/server/cart/request";
import { readJsonBody, validateBody } from "@/server/api/request";
import { getCartSnapshot } from "@/services/cart/cart.service";
import { previewCouponApplication, safeCouponError } from "@/services/promotions/promotion.service";

export const dynamic = "force-dynamic";
const limiter = createRateLimiter({ limit: 6, windowMs: 60_000, namespace: "promotion-preview" });
const previewSchema = z.object({ code: z.string().trim().min(3).max(64) }).strict();

/** A preview is read-only: it never reserves capacity or increments usage. */
export const POST = withErrorHandling(async (request: Request) => {
  if (!limiter.check(clientIp(request)).success) throw new RateLimitError();
  assertSameOriginJsonMutation(request);
  const body = validateBody(previewSchema, await readJsonBody(request));
  const identity = await cartRequestIdentity(request);
  const cart = await getCartSnapshot(identity.principal, { includePromotions: false });
  const preview = await previewCouponApplication({ cart, userId: identity.principal.userId, code: body.code });
  return apiOk({
    valid: preview.valid,
    code: preview.code,
    discountPaise: preview.valid ? preview.discountPaise : 0,
    message: preview.valid ? "Promotion is available for this cart." : safeCouponError(),
    totals: preview.valid ? preview.cart.totals : cart.totals,
    reservesCapacity: false,
  }, { headers: { "Cache-Control": "private, no-store" } });
}, "api-promotion-preview");
