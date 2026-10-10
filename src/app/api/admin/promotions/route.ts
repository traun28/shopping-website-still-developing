import { apiOk, withErrorHandling } from "@/lib/api-response";
import { RateLimitError } from "@/lib/errors";
import { clientIp, createRateLimiter } from "@/lib/rate-limit";
import { assertSameOriginJsonMutation } from "@/server/cart/session";
import { readJsonBody, validateBody } from "@/server/api/request";
import { requireCatalogEditorApi } from "@/server/auth/catalog-access";
import { createPromotion, listPromotions } from "@/services/promotions/promotion.service";
import { promotionCreateSchema } from "@/validations/promotions";

export const dynamic = "force-dynamic";
const limiter = createRateLimiter({ limit: 60, windowMs: 60_000, namespace: "admin-promotions" });

export const GET = withErrorHandling(async (request: Request) => {
  if (!limiter.check(clientIp(request)).success) throw new RateLimitError();
  await requireCatalogEditorApi();
  return apiOk(await listPromotions(), { headers: { "Cache-Control": "private, no-store" } });
}, "api-admin-promotions-list");

export const POST = withErrorHandling(async (request: Request) => {
  if (!limiter.check(clientIp(request)).success) throw new RateLimitError();
  assertSameOriginJsonMutation(request);
  const actor = await requireCatalogEditorApi();
  const body = validateBody(promotionCreateSchema, await readJsonBody(request));
  return apiOk(await createPromotion(body, actor.id), { status: 201, headers: { "Cache-Control": "private, no-store" } });
}, "api-admin-promotions-create");
