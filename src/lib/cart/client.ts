import { quantitySchema } from "@/lib/catalog/quantity";
import type { CartMutationResult, RecommendationAttribution } from "@/services/cart/types";
import type { ApiResult } from "@/lib/api-response";

export const CART_UPDATED_EVENT = "inkline:cart-updated";

interface CartApiErrorPayload {
  ok?: false;
  error?: { code?: string; message?: string };
}

export class CartClientError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code = "CART_ERROR") {
    super(message);
    this.name = "CartClientError";
    this.status = status;
    this.code = code;
  }
}

function idempotencyKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export async function cartMutation<T = CartMutationResult>(
  path: string,
  input: { method?: "POST" | "PATCH" | "DELETE"; body?: Record<string, unknown>; key?: string } = {},
): Promise<T> {
  const response = await fetch(path, {
    method: input.method ?? "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": input.key ?? idempotencyKey(),
    },
    body: JSON.stringify(input.body ?? {}),
  });
  let payload: ApiResult<T> | CartApiErrorPayload | null = null;
  try {
    payload = (await response.json()) as ApiResult<T> | CartApiErrorPayload;
  } catch {
    throw new CartClientError("The cart response could not be read. Please refresh and try again.", response.status);
  }
  if (!response.ok || !payload || !("ok" in payload) || payload.ok !== true) {
    const error = payload && "error" in payload ? payload.error : undefined;
    throw new CartClientError(error?.message ?? "Your cart could not be updated.", response.status, error?.code);
  }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CART_UPDATED_EVENT));
  return payload.data;
}

export interface AddToCartInput {
  productId: string;
  variantId: string;
  quantity: number;
  cartVersion?: number;
  source?: "PRODUCT_PAGE" | "PRODUCT_CARD" | "MINI_CART" | "CART_RECOMMENDATION" | "WISHLIST" | "SAVED_FOR_LATER" | "RESTORE_SAVED_ITEM" | "UNKNOWN";
  recommendation?: RecommendationAttribution | null;
}

export type AddToCartResult =
  | { status: "ADDED"; result: CartMutationResult }
  | { status: "REJECTED"; message: string; code?: string };

/** Browser boundary: only product/variant ids and quantity are sent; all pricing is server-side. */
export async function addProductToCart(input: AddToCartInput): Promise<AddToCartResult> {
  if (!quantitySchema.safeParse(input.quantity).success) {
    return { status: "REJECTED", message: "Choose a quantity between 1 and 10." };
  }
  try {
    const result = await cartMutation<CartMutationResult>("/api/cart/items", {
      body: {
        productId: input.productId,
        variantId: input.variantId,
        quantity: input.quantity,
        source: input.source ?? "PRODUCT_PAGE",
        cartVersion: input.cartVersion,
        recommendation: input.recommendation ?? undefined,
      },
    });
    return { status: "ADDED", result };
  } catch (error) {
    return {
      status: "REJECTED",
      message: error instanceof CartClientError ? error.message : "We couldn't check this item right now. Please try again.",
      code: error instanceof CartClientError ? error.code : undefined,
    };
  }
}
