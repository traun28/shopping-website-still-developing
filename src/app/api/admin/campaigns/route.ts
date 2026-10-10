import { apiOk, withErrorHandling } from "@/lib/api-response";
import { RateLimitError } from "@/lib/errors";
import { clientIp, createRateLimiter } from "@/lib/rate-limit";
import { assertSameOriginJsonMutation } from "@/server/cart/session";
import { readJsonBody, validateBody } from "@/server/api/request";
import { requireCatalogEditorApi } from "@/server/auth/catalog-access";
import { createCampaign, listCampaigns } from "@/services/promotions/promotion.service";
import { campaignWriteSchema } from "@/validations/promotions";

export const dynamic = "force-dynamic";
const limiter = createRateLimiter({ limit: 40, windowMs: 60_000, namespace: "admin-campaigns" });

export const GET = withErrorHandling(async (request: Request) => {
  if (!limiter.check(clientIp(request)).success) throw new RateLimitError();
  await requireCatalogEditorApi();
  return apiOk(await listCampaigns(), { headers: { "Cache-Control": "private, no-store" } });
}, "api-admin-campaigns-list");

export const POST = withErrorHandling(async (request: Request) => {
  if (!limiter.check(clientIp(request)).success) throw new RateLimitError();
  assertSameOriginJsonMutation(request);
  const actor = await requireCatalogEditorApi();
  const body = validateBody(campaignWriteSchema, await readJsonBody(request));
  return apiOk(await createCampaign(body, actor.id), { status: 201, headers: { "Cache-Control": "private, no-store" } });
}, "api-admin-campaigns-create");
