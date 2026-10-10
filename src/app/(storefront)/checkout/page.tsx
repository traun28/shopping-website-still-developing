import type { Metadata } from "next";
import { CheckoutClient } from "@/components/checkout/checkout-client";
import { buildMetadata } from "@/lib/seo";

export const metadata: Metadata = buildMetadata({ title: "Checkout", noIndex: true });

export default function CheckoutPage() {
  return <CheckoutClient />;
}
