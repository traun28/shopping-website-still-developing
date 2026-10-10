import { z } from "zod";
import { apiOk, withErrorHandling } from "@/lib/api-response";
import { NotFoundError, RateLimitError, UnauthorizedError } from "@/lib/errors";
import { clientIp, createRateLimiter } from "@/lib/rate-limit";
import { assertSameOriginJsonMutation } from "@/server/cart/session";
import { readJsonBody, validateBody } from "@/server/api/request";
import { getFreshUser } from "@/server/auth/session";
import { setDefaultBillingAddress, setDefaultShippingAddress } from "@/services/address.service";

export const dynamic = "force-dynamic";
const limiter = createRateLimiter({ limit: 20, windowMs: 60_000, namespace: "address-write" });

export const POST = withErrorHandling(async (request: Request, context: { params: Promise<{ addressId: string }> }) => {
  if (!limiter.check(clientIp(request)).success) throw new RateLimitError();
  assertSameOriginJsonMutation(request);
  const user = await getFreshUser();
  if (!user) throw new UnauthorizedError();
  const { addressId } = await context.params;
  if (!z.uuid().safeParse(addressId).success) throw new NotFoundError("Address not found.");
  const body = validateBody(z.object({ kind: z.enum(["SHIPPING", "BILLING"]) }).strict(), await readJsonBody(request));
  const data = body.kind === "SHIPPING"
    ? await setDefaultShippingAddress(user.id, addressId)
    : await setDefaultBillingAddress(user.id, addressId);
  return apiOk(data, { headers: { "Cache-Control": "private, no-store" } });
}, "api-address-default");
