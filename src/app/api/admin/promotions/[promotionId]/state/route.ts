import { z } from "zod";
import { apiOk, withErrorHandling } from "@/lib/api-response";
import { NotFoundError, RateLimitError } from "@/lib/errors";
import { clientIp, createRateLimiter } from "@/lib/rate-limit";
import { assertSameOriginJsonMutation } from "@/server/cart/session";
import { readJsonBody, validateBody } from "@/server/api/request";
import { requireCatalogEditorApi } from "@/server/auth/catalog-access";
import { transitionPromotion } from "@/services/promotions/promotion.service";
import { promotionStateSchema } from "@/validations/promotions";

export const dynamic = "force-dynamic";
const limiter = createRateLimiter({ limit: 40, windowMs: 60_000, namespace: "admin-promotion-state" });

export const POST = withErrorHandling(async (request: Request, context: { params: Promise<{ promotionId: string }> }) => {
  if (!limiter.check(clientIp(request)).success) throw new RateLimitError();
  assertSameOriginJsonMutation(request);
  const actor = await requireCatalogEditorApi();
  const { promotionId } = await context.params;
  if (!z.uuid().safeParse(promotionId).success) throw new NotFoundError("Promotion not found.");
  const body = validateBody(promotionStateSchema, await readJsonBody(request));
  return apiOk(await transitionPromotion(promotionId, body.expectedVersion, body.action, actor.id), { headers: { "Cache-Control": "private, no-store" } });
}, "api-admin-promotion-state");
