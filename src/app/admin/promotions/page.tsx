import { AdminShell } from "@/components/layouts/admin-shell";
import { PromotionsDashboard, type CampaignAdminRow, type PromotionAdminRow, type PromotionAnalyticsRow } from "@/components/admin/promotions-dashboard";
import { ErrorState } from "@/components/ui/error-state";
import { requireCatalogEditor } from "@/server/auth/catalog-access";
import { getPromotionAnalytics, listCampaigns, listPromotions } from "@/services/promotions/promotion.service";

export const dynamic = "force-dynamic";

export default async function AdminPromotionsPage() {
  await requireCatalogEditor();
  let data: { promotions: Record<string, unknown>[]; campaigns: Record<string, unknown>[]; analytics: Record<string, unknown>[] } | null = null;
  try {
    const [promotions, campaigns, analytics] = await Promise.all([
      listPromotions(),
      listCampaigns(),
      getPromotionAnalytics(),
    ]);
    data = { promotions, campaigns, analytics };
  } catch {
    data = null;
  }

  if (!data) {
    return (
      <AdminShell>
        <ErrorState
          kind="api"
          title="Promotion management is not ready"
          description="Apply drizzle/0011_promotion_domain.sql with npm run db:migrate, then refresh. Existing coupon rows are preserved and backfilled by that migration."
        />
      </AdminShell>
    );
  }

  return (
    <AdminShell>
      <PromotionsDashboard
        initialPromotions={data.promotions as unknown as PromotionAdminRow[]}
        initialCampaigns={data.campaigns as unknown as CampaignAdminRow[]}
        initialAnalytics={data.analytics as unknown as PromotionAnalyticsRow[]}
      />
    </AdminShell>
  );
}
