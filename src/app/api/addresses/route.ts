import { apiOk, withErrorHandling } from "@/lib/api-response";
import { RateLimitError, UnauthorizedError } from "@/lib/errors";
import { clientIp, createRateLimiter } from "@/lib/rate-limit";
import { assertSameOriginJsonMutation } from "@/server/cart/session";
import { readJsonBody, validateBody } from "@/server/api/request";
import { getFreshUser } from "@/server/auth/session";
import { addressSchema } from "@/validations/address";
import { createAddress, listAddresses } from "@/services/address.service";

export const dynamic = "force-dynamic";
const readLimiter = createRateLimiter({ limit: 60, windowMs: 60_000, namespace: "address-read" });
const writeLimiter = createRateLimiter({ limit: 20, windowMs: 60_000, namespace: "address-write" });

export const GET = withErrorHandling(async (request: Request) => {
  if (!readLimiter.check(clientIp(request)).success) throw new RateLimitError();
  const user = await getFreshUser();
  if (!user) throw new UnauthorizedError();
  const data = await listAddresses(user.id);
  return apiOk(data, { headers: { "Cache-Control": "private, no-store" } });
}, "api-address-list");

export const POST = withErrorHandling(async (request: Request) => {
  if (!writeLimiter.check(clientIp(request)).success) throw new RateLimitError();
  assertSameOriginJsonMutation(request);
  const user = await getFreshUser();
  if (!user) throw new UnauthorizedError();
  const input = validateBody(addressSchema, await readJsonBody(request));
  const data = await createAddress(user.id, input);
  return apiOk(data, { status: 201, headers: { "Cache-Control": "private, no-store" } });
}, "api-address-create");
