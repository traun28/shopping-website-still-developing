import "server-only";
import { logger } from "@/lib/logger";
import { applyEventToInterest, recordBehavioralEvent, recordRecommendationAction } from "@/services/recommendations/events.service";
import type { RecommendationType } from "@/lib/recommendations/types";
import type { CartAttributionSource } from "./types";

export interface CartEventActor {
  userId: string | null;
  /** Already hashed; never a raw guest token, IP or cookie. */
  sessionHash: string | null;
}

export interface CartEventDetails extends CartEventActor {
  eventType: string;
  productId?: string | null;
  variantId?: string | null;
  source?: CartAttributionSource | null;
  quantity?: number;
  warningCodes?: readonly string[];
  recommendation?: {
    id: string;
    type: RecommendationType;
    position: number;
    algorithmVersion: string;
  } | null;
}

/**
 * Cart lifecycle events share Part 13's existing append-only analytics stream.
 * They are best-effort after the committed mutation: analytics outages never
 * roll back a customer's basket. No payment, address or other sensitive data is
 * sent to this stream.
 */
export async function recordCartEvent(input: CartEventDetails): Promise<void> {
  const context: Record<string, unknown> = {};
  if (input.quantity !== undefined) context.quantity = input.quantity;
  if (input.source) context.source = input.source;
  if (input.warningCodes?.length) context.warningCodes = [...new Set(input.warningCodes)];

  const write = async (eventType: string) =>
    recordBehavioralEvent({
      eventType,
      userId: input.userId,
      sessionId: input.sessionHash,
      productId: input.productId,
      variantId: input.variantId,
      recommendationType: input.recommendation?.type ?? null,
      source: input.source ?? "cart",
      context: Object.keys(context).length ? context : null,
    });

  try {
    await write(input.eventType);
    // Part 13 consumes ADD_TO_CART/WISHLIST_* as interest signals. These are
    // separate from the more descriptive Part 14 lifecycle event above.
    if (input.eventType === "CART_ITEM_ADDED" || input.eventType === "WISHLIST_TO_CART") {
      await write("ADD_TO_CART");
      await applyEventToInterest({
        userId: input.userId,
        sessionId: input.sessionHash,
        eventType: "ADD_TO_CART",
        productId: input.productId,
      });
    }
    if (input.eventType === "CART_ITEM_REMOVED") {
      await write("REMOVE_FROM_CART");
    }
    if (input.eventType === "WISHLIST_TO_CART") {
      await write("WISHLIST_REMOVE");
      await applyEventToInterest({
        userId: input.userId,
        sessionId: input.sessionHash,
        eventType: "WISHLIST_REMOVE",
        productId: input.productId,
      });
    }
    if (input.recommendation && input.productId) {
      await recordRecommendationAction({
        eventType: "ADDED_TO_CART",
        recommendationId: input.recommendation.id,
        recommendationType: input.recommendation.type,
        productId: input.productId,
        position: input.recommendation.position,
        algorithmVersion: input.recommendation.algorithmVersion,
        userId: input.userId,
        sessionHash: input.sessionHash,
      });
    }
  } catch (error) {
    logger.warn("cart analytics event processing failed", {
      eventType: input.eventType,
      error: error instanceof Error ? error.message : "unknown",
    });
  }
}
