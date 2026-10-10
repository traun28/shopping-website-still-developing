import { z } from "zod";
import { apiOk, withErrorHandling } from "@/lib/api-response";
import { RateLimitError, UnauthorizedError, ValidationError } from "@/lib/errors";
import { clientIp, createRateLimiter } from "@/lib/rate-limit";
import { assertSameOriginJsonMutation } from "@/server/cart/session";
import { getFreshUser } from "@/server/auth/session";
import { addToWishlist, listWishlist, removeProductFromWishlist } from "@/services/wishlist.service";

export const dynamic = "force-dynamic";
const readLimiter = createRateLimiter({ limit: 60, windowMs: 60_000, namespace: "wishlist-read" });
const writeLimiter = createRateLimiter({ limit: 30, windowMs: 60_000, namespace: "wishlist-write" });
const bodySchema = z.object({ productId: z.string().uuid() }).strict();

export const GET = withErrorHandling(async (request: Request) => {
  if (!readLimiter.check(clientIp(request)).success) throw new RateLimitError();
  const user = await getFreshUser();
  if (!user) throw new UnauthorizedError("Sign in to view your wishlist.");
  return apiOk({ items: await listWishlist(user.id) }, { headers: { "Cache-Control": "private, no-store" } });
}, "api-wishlist-read");

export const POST = withErrorHandling(async (request: Request) => {
  if (!writeLimiter.check(clientIp(request)).success) throw new RateLimitError();
  assertSameOriginJsonMutation(request);
  const user = await getFreshUser();
  if (!user) throw new UnauthorizedError("Sign in to save to your wishlist.");
  let raw: unknown;
  try { raw = await request.json(); } catch { throw new ValidationError("Invalid request body."); }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid product id.");
  const added = await addToWishlist(user.id, parsed.data.productId);
  return apiOk({ saved: true, added }, { headers: { "Cache-Control": "private, no-store" } });
}, "api-wishlist-add");

export const DELETE = withErrorHandling(async (request: Request) => {
  if (!writeLimiter.check(clientIp(request)).success) throw new RateLimitError();
  assertSameOriginJsonMutation(request);
  const user = await getFreshUser();
  if (!user) throw new UnauthorizedError("Sign in to update your wishlist.");
  let raw: unknown;
  try { raw = await request.json(); } catch { throw new ValidationError("Invalid request body."); }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid product id.");
  await removeProductFromWishlist(user.id, parsed.data.productId);
  return apiOk({ saved: false }, { headers: { "Cache-Control": "private, no-store" } });
}, "api-wishlist-remove");
