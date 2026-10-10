import type { Metadata } from "next";
import { CartPageClient } from "@/components/cart/cart-page-client";
import { buildMetadata } from "@/lib/seo";

export const metadata: Metadata = buildMetadata({ title: "Your cart", noIndex: true });

export default function CartPage() {
  return <CartPageClient />;
}
