import { apiOk, withErrorHandling } from "@/lib/api-response";
import { RateLimitError, UnauthorizedError } from "@/lib/errors";
import { clientIp, createRateLimiter } from "@/lib/rate-limit";
import { assertSameOriginJsonMutation } from "@/server/cart/session";
import { readJsonBody, validateBody } from "@/server/api/request";
import { getFreshUser } from "@/server/auth/session";
import { getPreferences, savePreferences } from "@/services/preferences.service";
import { preferencesPatchSchema, preferencesSchema } from "@/validations/account";

export const dynamic = "force-dynamic";
const readLimiter = createRateLimiter({ limit: 60, windowMs: 60_000, namespace: "preferences-read" });
const writeLimiter = createRateLimiter({ limit: 12, windowMs: 60_000, namespace: "preferences-write" });

export const GET = withErrorHandling(async (request: Request) => {
  if (!readLimiter.check(clientIp(request)).success) throw new RateLimitError();
  const user = await getFreshUser();
  if (!user) throw new UnauthorizedError();
  return apiOk(await getPreferences(user.id), { headers: { "Cache-Control": "private, no-store" } });
}, "api-preferences-read");

export const PATCH = withErrorHandling(async (request: Request) => {
  if (!writeLimiter.check(clientIp(request)).success) throw new RateLimitError();
  assertSameOriginJsonMutation(request);
  const user = await getFreshUser();
  if (!user) throw new UnauthorizedError();
  const patch = validateBody(preferencesPatchSchema, await readJsonBody(request));
  const current = await getPreferences(user.id);
  const complete = validateBody(preferencesSchema, { ...current, ...patch });
  const data = await savePreferences(user.id, complete, { source: "ACCOUNT_API" });
  return apiOk(data, { headers: { "Cache-Control": "private, no-store" } });
}, "api-preferences-update");
