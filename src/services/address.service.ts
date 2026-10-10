import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { addresses, users, type Address } from "@/db/schema";
import { withTransaction, type DbClient } from "@/db/utils";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { writeAudit } from "@/services/audit.service";
import { addressValidationService, type NormalizedAddressInput } from "@/services/address-validation.service";
import type { AddressInput, AddressPatchInput } from "@/validations/address";

/**
 * Address book service — all reads and writes are scoped by the authenticated
 * owner id supplied by the fresh-session boundary. Format validation is not
 * physical verification, and duplicate matches are warnings only.
 */

export type AddressDTO = Address & { isDefaultShipping: boolean };
export interface AddressMutationResult {
  address: AddressDTO;
  possibleDuplicate: boolean;
  possibleDuplicateAddressId: string | null;
}

function toDTO(row: Address): AddressDTO {
  return { ...row, isDefaultShipping: row.isDefault };
}

function toInput(row: Address): Record<string, unknown> {
  return {
    fullName: row.fullName,
    phone: row.phone,
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2 ?? "",
    locality: row.locality ?? "",
    landmark: row.landmark ?? "",
    deliveryInstructions: row.deliveryInstructions ?? "",
    city: row.city,
    state: row.state ?? "",
    postalCode: row.postalCode ?? "",
    country: row.country,
    addressType: row.addressType,
    isDefaultShipping: row.isDefault,
    isDefaultBilling: row.isDefaultBilling,
  };
}

function toRowValues(userId: string, value: NormalizedAddressInput) {
  return {
    userId,
    fullName: value.fullName,
    phone: value.phone,
    addressLine1: value.addressLine1,
    addressLine2: value.addressLine2 || null,
    locality: value.locality || null,
    landmark: value.landmark || null,
    deliveryInstructions: value.deliveryInstructions || null,
    city: value.city,
    state: value.state || null,
    postalCode: value.postalCode || null,
    country: value.country,
    addressType: value.addressType,
    isDefault: value.isDefaultShipping,
    isDefaultBilling: value.isDefaultBilling,
  };
}

async function lockOwner(userId: string, client: DbClient): Promise<void> {
  const [owner] = await client.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("update");
  if (!owner) throw new NotFoundError("Account not found.");
}

async function findDuplicate(
  userId: string,
  value: NormalizedAddressInput,
  excludeId: string | null,
  client: DbClient,
): Promise<string | null> {
  const rows = await client.select().from(addresses).where(eq(addresses.userId, userId));
  for (const row of rows) {
    if (row.id === excludeId) continue;
    const candidate = addressValidationService.validate(toInput(row));
    if (addressValidationService.likelyDuplicate(value, candidate)) return row.id;
  }
  return null;
}

async function getOwnedAddress(userId: string, addressId: string, client: DbClient = db): Promise<Address> {
  const [row] = await client
    .select()
    .from(addresses)
    .where(and(eq(addresses.id, addressId), eq(addresses.userId, userId)))
    .limit(1);
  if (!row) throw new NotFoundError("Address not found.");
  return row;
}

export async function listAddresses(userId: string): Promise<AddressDTO[]> {
  const rows = await db
    .select()
    .from(addresses)
    .where(eq(addresses.userId, userId))
    .orderBy(desc(addresses.isDefault), desc(addresses.isDefaultBilling), desc(addresses.createdAt));
  return rows.map(toDTO);
}

export async function getAddress(userId: string, addressId: string): Promise<AddressDTO> {
  return toDTO(await getOwnedAddress(userId, addressId));
}

export async function createAddress(userId: string, input: AddressInput): Promise<AddressMutationResult> {
  const value = addressValidationService.validate(input);
  const result = await withTransaction(async (tx) => {
    await lockOwner(userId, tx);
    const existing = await tx.select({ id: addresses.id }).from(addresses).where(eq(addresses.userId, userId));
    const isDefaultShipping = value.isDefaultShipping || existing.length === 0;
    const duplicateId = await findDuplicate(userId, value, null, tx);

    if (isDefaultShipping) {
      await tx.update(addresses).set({
        isDefault: false,
        version: sql`${addresses.version} + 1`,
        updatedAt: new Date(),
      }).where(and(eq(addresses.userId, userId), eq(addresses.isDefault, true)));
    }
    if (value.isDefaultBilling) {
      await tx.update(addresses).set({
        isDefaultBilling: false,
        version: sql`${addresses.version} + 1`,
        updatedAt: new Date(),
      }).where(and(eq(addresses.userId, userId), eq(addresses.isDefaultBilling, true)));
    }

    const [created] = await tx
      .insert(addresses)
      .values({ ...toRowValues(userId, { ...value, isDefaultShipping }), version: 1 })
      .returning();
    if (!created) throw new Error("Address insert returned no row.");
    return { address: toDTO(created), duplicateId };
  });

  await writeAudit({
    action: "address.created",
    entityType: "address",
    entityId: result.address.id,
    actorId: userId,
    metadata: {
      addressType: result.address.addressType,
      isDefaultShipping: result.address.isDefault,
      isDefaultBilling: result.address.isDefaultBilling,
      possibleDuplicate: Boolean(result.duplicateId),
    },
  });
  return {
    address: result.address,
    possibleDuplicate: Boolean(result.duplicateId),
    possibleDuplicateAddressId: result.duplicateId,
  };
}

export async function updateAddress(
  userId: string,
  addressId: string,
  input: AddressPatchInput | AddressInput,
  options: { expectedVersion?: number } = {},
): Promise<AddressMutationResult> {
  const result = await withTransaction(async (tx) => {
    await lockOwner(userId, tx);
    const current = await getOwnedAddress(userId, addressId, tx);
    if (options.expectedVersion !== undefined && options.expectedVersion !== current.version) {
      throw new ConflictError("This address changed in another tab. Refresh and try again.", "ADDRESS_VERSION_CONFLICT");
    }

    const patch = Object.fromEntries(Object.entries(input).filter(([key]) => key !== "expectedVersion"));
    const normalized = addressValidationService.validate({
      ...toInput(current),
      ...patch,
      isDefaultShipping: input.isDefaultShipping ?? current.isDefault,
      isDefaultBilling: input.isDefaultBilling ?? current.isDefaultBilling,
    });
    const duplicateId = await findDuplicate(userId, normalized, addressId, tx);

    if (normalized.isDefaultShipping) {
      await tx.update(addresses).set({
        isDefault: false,
        version: sql`${addresses.version} + 1`,
        updatedAt: new Date(),
      }).where(and(
        eq(addresses.userId, userId),
        sql`${addresses.id} <> ${addressId}`,
        eq(addresses.isDefault, true),
      ));
    }
    if (normalized.isDefaultBilling) {
      await tx.update(addresses).set({
        isDefaultBilling: false,
        version: sql`${addresses.version} + 1`,
        updatedAt: new Date(),
      }).where(and(
        eq(addresses.userId, userId),
        sql`${addresses.id} <> ${addressId}`,
        eq(addresses.isDefaultBilling, true),
      ));
    }

    const [updated] = await tx
      .update(addresses)
      .set({
        ...toRowValues(userId, normalized),
        version: sql`${addresses.version} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(addresses.id, addressId), eq(addresses.userId, userId)))
      .returning();
    if (!updated) throw new NotFoundError("Address not found.");
    return { address: toDTO(updated), duplicateId };
  });

  await writeAudit({
    action: "address.updated",
    entityType: "address",
    entityId: addressId,
    actorId: userId,
    metadata: {
      version: result.address.version,
      isDefaultShipping: result.address.isDefault,
      isDefaultBilling: result.address.isDefaultBilling,
      possibleDuplicate: Boolean(result.duplicateId),
    },
  });
  return {
    address: result.address,
    possibleDuplicate: Boolean(result.duplicateId),
    possibleDuplicateAddressId: result.duplicateId,
  };
}

export async function deleteAddress(
  userId: string,
  addressId: string,
  options: { expectedVersion?: number } = {},
): Promise<void> {
  await withTransaction(async (tx) => {
    await lockOwner(userId, tx);
    const current = await getOwnedAddress(userId, addressId, tx);
    if (options.expectedVersion !== undefined && options.expectedVersion !== current.version) {
      throw new ConflictError("This address changed in another tab. Refresh and try again.", "ADDRESS_VERSION_CONFLICT");
    }
    await tx.delete(addresses).where(and(eq(addresses.id, addressId), eq(addresses.userId, userId)));
  });
  await writeAudit({
    action: "address.deleted",
    entityType: "address",
    entityId: addressId,
    actorId: userId,
    metadata: { addressContentsLogged: false },
  });
}

async function setDefault(
  userId: string,
  addressId: string,
  kind: "shipping" | "billing",
): Promise<AddressDTO> {
  const result = await withTransaction(async (tx) => {
    await lockOwner(userId, tx);
    await getOwnedAddress(userId, addressId, tx);
    if (kind === "shipping") {
      await tx.update(addresses).set({
        isDefault: false,
        version: sql`${addresses.version} + 1`,
        updatedAt: new Date(),
      }).where(and(
        eq(addresses.userId, userId),
        sql`${addresses.id} <> ${addressId}`,
        eq(addresses.isDefault, true),
      ));
      const [updated] = await tx
        .update(addresses)
        .set({ isDefault: true, version: sql`${addresses.version} + 1`, updatedAt: new Date() })
        .where(and(eq(addresses.id, addressId), eq(addresses.userId, userId)))
        .returning();
      if (!updated) throw new NotFoundError("Address not found.");
      return updated;
    }

    await tx.update(addresses).set({
      isDefaultBilling: false,
      version: sql`${addresses.version} + 1`,
      updatedAt: new Date(),
    }).where(and(
      eq(addresses.userId, userId),
      sql`${addresses.id} <> ${addressId}`,
      eq(addresses.isDefaultBilling, true),
    ));
    const [updated] = await tx
      .update(addresses)
      .set({ isDefaultBilling: true, version: sql`${addresses.version} + 1`, updatedAt: new Date() })
      .where(and(eq(addresses.id, addressId), eq(addresses.userId, userId)))
      .returning();
    if (!updated) throw new NotFoundError("Address not found.");
    return updated;
  });

  await writeAudit({
    action: `address.default_${kind}_set`,
    entityType: "address",
    entityId: addressId,
    actorId: userId,
    metadata: { addressContentsLogged: false },
  });
  return toDTO(result);
}

export async function setDefaultShippingAddress(userId: string, addressId: string): Promise<AddressDTO> {
  return setDefault(userId, addressId, "shipping");
}

export async function setDefaultBillingAddress(userId: string, addressId: string): Promise<AddressDTO> {
  return setDefault(userId, addressId, "billing");
}

/** Compatibility for the existing settings action: default means shipping. */
export async function setDefaultAddress(userId: string, addressId: string): Promise<AddressDTO> {
  return setDefaultShippingAddress(userId, addressId);
}
