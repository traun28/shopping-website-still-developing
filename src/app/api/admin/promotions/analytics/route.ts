import { apiOk, withErrorHandling } from "@/lib/api-response";
import { RateLimitError } from "@/lib/errors";
import { clientIp, createRateLimiter } from "@/lib/rate-limit";
import { requireCatalogEditorApi } from "@/server/auth/catalog-access";
import { getPromotionAnalytics } from "@/services/promotions/promotion.service";

export const dynamic = "force-dynamic";
const limiter = createRateLimiter({ limit: 30, windowMs: 60_000, namespace: "admin-promotion-analytics" });

export const GET = withErrorHandling(async (request: Request) => {
  if (!limiter.check(clientIp(request)).success) throw new RateLimitError();
  await requireCatalogEditorApi();
  return apiOk(await getPromotionAnalytics(), { headers: { "Cache-Control": "private, no-store" } });
}, "api-admin-promotion-analytics");
