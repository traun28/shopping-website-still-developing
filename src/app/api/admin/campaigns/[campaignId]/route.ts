import { z } from "zod";
import { apiOk, withErrorHandling } from "@/lib/api-response";
import { NotFoundError, RateLimitError } from "@/lib/errors";
import { clientIp, createRateLimiter } from "@/lib/rate-limit";
import { assertSameOriginJsonMutation } from "@/server/cart/session";
import { readJsonBody, validateBody } from "@/server/api/request";
import { requireCatalogEditorApi } from "@/server/auth/catalog-access";
import { updateCampaign } from "@/services/promotions/promotion.service";
import { campaignUpdateSchema } from "@/validations/promotions";

export const dynamic = "force-dynamic";
const limiter = createRateLimiter({ limit: 40, windowMs: 60_000, namespace: "admin-campaign-write" });

export const PATCH = withErrorHandling(async (request: Request, context: { params: Promise<{ campaignId: string }> }) => {
  if (!limiter.check(clientIp(request)).success) throw new RateLimitError();
  assertSameOriginJsonMutation(request);
  const actor = await requireCatalogEditorApi();
  const { campaignId } = await context.params;
  if (!z.uuid().safeParse(campaignId).success) throw new NotFoundError("Campaign not found.");
  const body = validateBody(campaignUpdateSchema, await readJsonBody(request));
  return apiOk(await updateCampaign(campaignId, body, actor.id), { headers: { "Cache-Control": "private, no-store" } });
}, "api-admin-campaign-update");
