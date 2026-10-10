import { apiOk, withErrorHandling } from "@/lib/api-response";
import { RateLimitError, UnauthorizedError } from "@/lib/errors";
import { clientIp, createRateLimiter } from "@/lib/rate-limit";
import { assertSameOriginJsonMutation } from "@/server/cart/session";
import { readJsonBody, validateBody } from "@/server/api/request";
import { authRequestContext, getFreshUser } from "@/server/auth/session";
import { updateProfile } from "@/services/auth.service";
import { getCustomerProfile } from "@/services/profile.service";
import { profilePatchSchema } from "@/validations/auth";

export const dynamic = "force-dynamic";
const readLimiter = createRateLimiter({ limit: 60, windowMs: 60_000, namespace: "profile-read" });
const writeLimiter = createRateLimiter({ limit: 12, windowMs: 60_000, namespace: "profile-write" });

export const GET = withErrorHandling(async (request: Request) => {
  if (!readLimiter.check(clientIp(request)).success) throw new RateLimitError();
  const user = await getFreshUser();
  if (!user) throw new UnauthorizedError();
  return apiOk(await getCustomerProfile(user.id), { headers: { "Cache-Control": "private, no-store" } });
}, "api-profile-read");

export const PATCH = withErrorHandling(async (request: Request) => {
  if (!writeLimiter.check(clientIp(request)).success) throw new RateLimitError();
  assertSameOriginJsonMutation(request);
  const user = await getFreshUser();
  if (!user) throw new UnauthorizedError();
  const patch = validateBody(profilePatchSchema, await readJsonBody(request));
  await updateProfile(user.id, patch, await authRequestContext(request.headers));
  return apiOk(await getCustomerProfile(user.id), { headers: { "Cache-Control": "private, no-store" } });
}, "api-profile-update");
