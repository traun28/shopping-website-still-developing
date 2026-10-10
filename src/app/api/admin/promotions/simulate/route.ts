import { apiOk, withErrorHandling } from "@/lib/api-response";
import { RateLimitError } from "@/lib/errors";
import { clientIp, createRateLimiter } from "@/lib/rate-limit";
import { assertSameOriginJsonMutation } from "@/server/cart/session";
import { readJsonBody, validateBody } from "@/server/api/request";
import { requireCatalogEditorApi } from "@/server/auth/catalog-access";
import { simulatePromotion } from "@/services/promotions/promotion.service";
import { promotionSimulationSchema } from "@/validations/promotions";

export const dynamic = "force-dynamic";
const limiter = createRateLimiter({ limit: 20, windowMs: 60_000, namespace: "admin-promotion-simulation" });

export const POST = withErrorHandling(async (request: Request) => {
  if (!limiter.check(clientIp(request)).success) throw new RateLimitError();
  assertSameOriginJsonMutation(request);
  await requireCatalogEditorApi();
  const body = validateBody(promotionSimulationSchema, await readJsonBody(request));
  return apiOk(await simulatePromotion(body), { headers: { "Cache-Control": "private, no-store" } });
}, "api-admin-promotion-simulation");
