import { z } from "zod";
import { apiOk, withErrorHandling } from "@/lib/api-response";
import { NotFoundError, RateLimitError, UnauthorizedError, ValidationError } from "@/lib/errors";
import { clientIp, createRateLimiter } from "@/lib/rate-limit";
import { assertSameOriginJsonMutation } from "@/server/cart/session";
import { readJsonBody, validateBody } from "@/server/api/request";
import { getFreshUser } from "@/server/auth/session";
import { addressPatchSchema } from "@/validations/address";
import { deleteAddress, getAddress, updateAddress } from "@/services/address.service";

export const dynamic = "force-dynamic";
const readLimiter = createRateLimiter({ limit: 60, windowMs: 60_000, namespace: "address-read" });
const writeLimiter = createRateLimiter({ limit: 20, windowMs: 60_000, namespace: "address-write" });

async function addressIdFrom(context: { params: Promise<{ addressId: string }> }): Promise<string> {
  const { addressId } = await context.params;
  if (!z.uuid().safeParse(addressId).success) throw new NotFoundError("Address not found.");
  return addressId;
}

export const GET = withErrorHandling(async (request: Request, context: { params: Promise<{ addressId: string }> }) => {
  if (!readLimiter.check(clientIp(request)).success) throw new RateLimitError();
  const user = await getFreshUser();
  if (!user) throw new UnauthorizedError();
  const addressId = await addressIdFrom(context);
  const data = await getAddress(user.id, addressId);
  return apiOk(data, { headers: { "Cache-Control": "private, no-store" } });
}, "api-address-get");

export const PATCH = withErrorHandling(async (request: Request, context: { params: Promise<{ addressId: string }> }) => {
  if (!writeLimiter.check(clientIp(request)).success) throw new RateLimitError();
  assertSameOriginJsonMutation(request);
  const user = await getFreshUser();
  if (!user) throw new UnauthorizedError();
  const addressId = await addressIdFrom(context);
  const patch = validateBody(addressPatchSchema, await readJsonBody(request));
  const { expectedVersion, ...fields } = patch;
  if (Object.keys(fields).length === 0) throw new ValidationError("Choose at least one address field to update.");
  const data = await updateAddress(user.id, addressId, fields, { expectedVersion });
  return apiOk(data, { headers: { "Cache-Control": "private, no-store" } });
}, "api-address-update");

export const DELETE = withErrorHandling(async (request: Request, context: { params: Promise<{ addressId: string }> }) => {
  if (!writeLimiter.check(clientIp(request)).success) throw new RateLimitError();
  assertSameOriginJsonMutation(request);
  const user = await getFreshUser();
  if (!user) throw new UnauthorizedError();
  const addressId = await addressIdFrom(context);
  const body = validateBody(z.object({ expectedVersion: z.number().int().positive().optional() }).strict(), await readJsonBody(request));
  await deleteAddress(user.id, addressId, { expectedVersion: body.expectedVersion });
  return apiOk({ deleted: true }, { headers: { "Cache-Control": "private, no-store" } });
}, "api-address-delete");
