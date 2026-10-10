"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { CART_UPDATED_EVENT } from "@/lib/cart/client";
import type { CartDTO } from "@/types/cart";

interface CartContextValue {
  cart: CartDTO | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

const CartContext = createContext<CartContextValue | null>(null);

export function CartProvider({ children }: { children: ReactNode }) {
  const [cart, setCart] = useState<CartDTO | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/cart", { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) return;
      const body = (await response.json()) as { ok?: boolean; data?: CartDTO };
      if (body.ok && body.data) setCart(body.data);
    } catch {
      // Cart availability must never block the rest of the storefront.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Schedule the initial fetch after mount; the effect itself only manages
    // subscriptions and never synchronously schedules a React state update.
    const initialLoad = window.setTimeout(() => void refresh(), 0);
    const onUpdate = () => void refresh();
    window.addEventListener(CART_UPDATED_EVENT, onUpdate);
    return () => {
      window.clearTimeout(initialLoad);
      window.removeEventListener(CART_UPDATED_EVENT, onUpdate);
    };
  }, [refresh]);

  const value = useMemo(() => ({ cart, loading, refresh }), [cart, loading, refresh]);
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const context = useContext(CartContext);
  if (!context) throw new Error("useCart must be used inside <CartProvider>.");
  return context;
}
