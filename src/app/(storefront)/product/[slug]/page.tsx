import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { Suspense } from "react";
import { ProductExperience, type ProductExperienceProduct } from "@/components/product/product-experience";
import { ProductInfoSections } from "@/components/product/product-info";
import { ProductLoadError } from "@/components/product/product-load-error";
import { ProductReviews } from "@/components/product/product-reviews";
import { RelatedProducts } from "@/components/product/related-products";
import {
  CrossSellRail,
  FrequentlyBoughtTogetherRail,
  SimilarProductsRail,
} from "@/components/recommendations/recommendation-rail";
import { RelatedSkeleton, SectionSkeleton } from "@/components/product/product-skeleton";
import { ProductViewTracker } from "@/components/product/product-view-tracker";
import { JsonLd } from "@/components/storefront/json-ld";
import { Breadcrumbs } from "@/components/ui/breadcrumbs";
import { Container } from "@/components/ui/container";
import { buildProductBreadcrumbs, similarProductsHref } from "@/lib/catalog/pdp-breadcrumbs";
import type { PdpProductDTO } from "@/lib/catalog/pdp-dto";
import { selectionFromParams } from "@/lib/catalog/variant-selection";
import { resolveRecommendationType, type RecommendationType } from "@/lib/recommendations/types";
import type { RecommendationAttribution } from "@/services/cart/types";
import { plainText } from "@/lib/plain-text";
import { breadcrumbJsonLd, productJsonLd, productMetadata } from "@/lib/seo";
import { productPath } from "@/lib/storefront-paths";
import { resolveSlug } from "@/lib/storefront-route";
import { findProductSlugRedirect } from "@/services/catalog.service";
import { getProductPage } from "@/services/catalog/product-page.service";
import { getSavedProductIds, loadSection } from "@/services/storefront.service";

type SearchParams = Record<string, string | string[] | undefined>;
type Props = { params: Promise<{ slug: string }>; searchParams: Promise<SearchParams> };

/** First value of a query param, bounded. Validation happens against real variants. */
function firstParam(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" ? raw.slice(0, 40) : null;
}

function recommendationFromParams(params: SearchParams): RecommendationAttribution | null {
  const value = (key: string, max: number) => {
    const raw = firstParam(params[key]);
    return raw?.slice(0, max) ?? null;
  };
  const id = value("recId", 128);
  const type = resolveRecommendationType(value("recType", 64));
  const positionRaw = value("recPosition", 8);
  const algorithmVersion = value("recAlgorithm", 80);
  const position = positionRaw ? Number(positionRaw) : NaN;
  if (!id || id.length < 8 || !type || !Number.isInteger(position) || position < 0 || position > 100 || !algorithmVersion) return null;
  return { id, type: type as RecommendationType, position, algorithmVersion };
}

export async function generateMetadata({ params }: Pick<Props, "params">): Promise<Metadata> {
  const { slug: raw } = await params;
  const slug = resolveSlug(raw, "/product");
  try {
    const product = await getProductPage(slug);
    if (!product) {
      return { title: "Product not found", robots: { index: false, follow: false } };
    }
    const firstParagraph = product.description?.split("\n\n")[0];
    return productMetadata({
      title: product.seo.title || product.name,
      description: product.seo.description || product.shortDescription || firstParagraph,
      slug: product.slug,
      image: product.seo.image,
      // A product nobody can order is not something to send search traffic to.
      noIndex: !product.purchasable,
    });
  } catch {
    return productMetadata({ title: "Product", slug, noIndex: true });
  }
}

export default async function ProductPage({ params, searchParams }: Props) {
  const { slug: raw } = await params;
  const slug = resolveSlug(raw, "/product");

  const result = await loadSection<PdpProductDTO | null>("product", () => getProductPage(slug), null);
  if (result.status === "error") {
    return (
      <Container className="py-16">
        <ProductLoadError />
      </Container>
    );
  }
  if (!result.data) {
    // A renamed product keeps working at its old address (permanent redirect).
    const nextSlug = await findProductSlugRedirect(slug).catch(() => null);
    if (nextSlug && nextSlug !== slug) permanentRedirect(productPath(nextSlug));
    notFound();
  }

  const product = result.data;
  const query = await searchParams;
  const crumbs = buildProductBreadcrumbs(product);
  const savedIds = await getSavedProductIds().catch(() => [] as string[]);
  const initialSelection = selectionFromParams(product.variants, {
    color: firstParam(query.color),
    size: firstParam(query.size),
  });
  const recommendation = recommendationFromParams(query);

  // Only what the interactive area needs; long-form content stays on the server.
  const experience: ProductExperienceProduct = {
    id: product.id,
    slug: product.slug,
    name: product.name,
    shortDescription: product.shortDescription,
    productTypeLabel: product.productTypeLabel,
    price: product.price,
    variants: product.variants,
    colors: product.colors,
    sizes: product.sizes,
    purchasable: product.purchasable,
    images: product.images,
    sizeChart: product.sizeChart,
    rating: product.rating,
    isNew: product.isNew,
  };
  const categoryLabel = product.categoryTrail[product.categoryTrail.length - 1]?.name ?? product.productTypeLabel;

  return (
    <>
      <JsonLd
        data={[
          breadcrumbJsonLd(crumbs.map((crumb) => ({ name: crumb.label, path: crumb.path }))),
          productJsonLd({
            name: product.name,
            description: plainText(product.shortDescription || product.description, 300),
            slug: product.slug,
            image: product.seo.image,
            pricePaise: product.price.amountPaise,
            availability: product.purchasable ? "in_stock" : "sold_out",
            sku: product.variants.length === 1 ? product.variants[0]?.sku : undefined,
            // Only genuine review data — omitted entirely when there are no approved reviews.
            rating: product.rating ? { value: product.rating.average, count: product.rating.count } : undefined,
            offers: product.variants.map((variant) => ({
              sku: variant.sku,
              pricePaise: variant.price.amountPaise,
              orderable: variant.state === "AVAILABLE",
            })),
          }),
        ]}
      />
      <ProductViewTracker slug={product.slug} />
      <Container className="py-6 md:py-10">
        <Breadcrumbs items={crumbs.map((crumb) => ({ label: crumb.label, href: crumb.path }))} />

        <div className="mt-6 md:mt-8">
          <ProductExperience
            product={experience}
            initialSelection={initialSelection}
            saved={savedIds.includes(product.id)}
            categoryLabel={categoryLabel}
            browseHref={similarProductsHref(product)}
            recommendation={recommendation}
          >
            <ProductInfoSections product={product} />
          </ProductExperience>
        </div>

        <div className="mt-16 space-y-16 md:mt-20">
          <Suspense fallback={<SectionSkeleton rows={4} label="Loading reviews" />}>
            <ProductReviews productId={product.id} />
          </Suspense>
          <Suspense fallback={<RelatedSkeleton />}>
            <RelatedProducts productId={product.id} />
          </Suspense>

          {/* Part 13 rails. Each fetches its own candidates and defers the
              request until it is near the viewport, so adding them costs the
              initial paint nothing. A rail with no candidates renders nothing
              rather than an empty heading — see RecommendationRail.

              These sit *alongside* the structural RelatedProducts above rather
              than replacing it: that component ranks by shared collection and
              tags, these by precomputed similarity and co-purchase. When the
              offline job has not run yet, the structural one is the only rail
              with anything to say. */}
          <SimilarProductsRail productId={product.id} limit={8} />
          <FrequentlyBoughtTogetherRail productId={product.id} limit={6} />
          <CrossSellRail productId={product.id} limit={6} />
        </div>
      </Container>
    </>
  );
}
