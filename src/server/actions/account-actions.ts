"use server";

import { headers } from "next/headers";
import { z, type ZodType } from "zod";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { getFreshUser } from "@/server/auth/session";
import {
  addressSchema,
  deactivateAccountSchema,
  emailChangeRequestSchema,
  preferencesSchema,
} from "@/validations/account";
import {
  createAddress,
  deleteAddress,
  setDefaultAddress,
  setDefaultBillingAddress,
  updateAddress,
} from "@/services/address.service";
import {
  addToWishlist,
  removeFromWishlist,
  toggleWishlist,
} from "@/services/wishlist.service";
import {
  markAllNotificationsRead,
  markNotificationRead,
} from "@/services/notification.service";
import { savePreferences } from "@/services/preferences.service";
import {
  deactivateAccount,
  requestDataExport,
  requestEmailChange,
} from "@/services/account.service";
import { removeAvatar, uploadAvatar } from "@/services/avatar.service";
import { signOut } from "@/auth";
import type { ActionResult, FieldErrors } from "@/server/actions/auth-actions";

export type { ActionResult, FieldErrors };

/* ── plumbing ─────────────────────────────────────────────────────────── */

async function context() {
  const list = await headers();
  const forwarded = list.get("x-forwarded-for");
  return {
    ip: forwarded?.split(",")[0]?.trim() ?? list.get("x-real-ip") ?? undefined,
    userAgent: list.get("user-agent") ?? undefined,
  };
}

async function authedUserId(): Promise<string | null> {
  const user = await getFreshUser();
  return user?.id ?? null;
}

const SESSION_ERROR: ActionResult = { ok: false, error: "Your session expired. Please sign in again." };

function zodFailure(error: z.ZodError): ActionResult {
  const flattened = z.flattenError(error);
  const fieldErrors: FieldErrors = {};
  for (const [field, messages] of Object.entries(flattened.fieldErrors)) {
    const first = Array.isArray(messages) ? messages[0] : undefined;
    if (first) fieldErrors[field] = first;
  }
  return { ok: false, error: Object.values(fieldErrors)[0] ?? "Please check the form.", fieldErrors };
}

function fail(error: unknown): ActionResult {
  if (error instanceof AppError) return { ok: false, error: error.message };
  logger.error("Account action failed", { error: error instanceof Error ? error.message : "unknown" });
  return { ok: false, error: "Something went wrong. Please try again." };
}

async function parse<S extends ZodType>(schema: S, formData: FormData) {
  const raw: Record<string, unknown> = Object.fromEntries(formData.entries());
  for (const key of ["isDefault", "isDefaultShipping", "isDefaultBilling", "marketingEmails", "orderNotifications", "promotionalNotifications"]) {
    if (key in raw) raw[key] = raw[key] === "true" || raw[key] === "on";
  }
  if (typeof raw.expectedVersion === "string" && raw.expectedVersion.trim()) {
    raw.expectedVersion = Number(raw.expectedVersion);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false as const, result: zodFailure(parsed.error) };
  return { ok: true as const, data: parsed.data as z.infer<S> };
}

/* ── addresses ────────────────────────────────────────────────────────── */

export async function createAddressAction(_prev: unknown, formData: FormData): Promise<ActionResult> {
  const userId = await authedUserId();
  if (!userId) return SESSION_ERROR;
  const parsed = await parse(addressSchema, formData);
  if (!parsed.ok) return parsed.result;
  try {
    const result = await createAddress(userId, parsed.data);
    return {
      ok: true,
      message: result.possibleDuplicate
        ? "Address saved. It resembles another saved address; nothing was merged."
        : "Address saved.",
    };
  } catch (error) {
    return fail(error);
  }
}

export async function updateAddressAction(addressId: string, _prev: unknown, formData: FormData): Promise<ActionResult> {
  const userId = await authedUserId();
  if (!userId) return SESSION_ERROR;
  const parsed = await parse(addressSchema, formData);
  if (!parsed.ok) return parsed.result;
  try {
    const result = await updateAddress(userId, addressId, parsed.data, { expectedVersion: parsed.data.expectedVersion });
    return {
      ok: true,
      message: result.possibleDuplicate
        ? "Address updated. It resembles another saved address; nothing was merged."
        : "Address updated.",
    };
  } catch (error) {
    return fail(error);
  }
}

export async function deleteAddressAction(addressId: string, expectedVersion?: number): Promise<ActionResult> {
  const userId = await authedUserId();
  if (!userId) return SESSION_ERROR;
  try {
    await deleteAddress(userId, addressId, { expectedVersion });
    return { ok: true, message: "Address removed." };
  } catch (error) {
    return fail(error);
  }
}

export async function setDefaultAddressAction(addressId: string): Promise<ActionResult> {
  const userId = await authedUserId();
  if (!userId) return SESSION_ERROR;
  try {
    await setDefaultAddress(userId, addressId);
    return { ok: true, message: "Default shipping address updated." };
  } catch (error) {
    return fail(error);
  }
}

export async function setDefaultBillingAddressAction(addressId: string): Promise<ActionResult> {
  const userId = await authedUserId();
  if (!userId) return SESSION_ERROR;
  try {
    await setDefaultBillingAddress(userId, addressId);
    return { ok: true, message: "Default billing address updated." };
  } catch (error) {
    return fail(error);
  }
}

/* ── wishlist ─────────────────────────────────────────────────────────── */

export type WishlistToggleResult =
  | { ok: true; saved: boolean }
  | { ok: false; error: string; requiresLogin?: boolean };

export async function toggleWishlistAction(productId: string): Promise<WishlistToggleResult> {
  const userId = await authedUserId();
  if (!userId) return { ok: false, error: "Sign in to save to your wishlist.", requiresLogin: true };
  try {
    const result = await toggleWishlist(userId, productId);
    return { ok: true, saved: result.saved };
  } catch (error) {
    return { ok: false, error: error instanceof AppError ? error.message : "Couldn't update your wishlist." };
  }
}

export async function addToWishlistAction(productId: string): Promise<WishlistToggleResult> {
  const userId = await authedUserId();
  if (!userId) return { ok: false, error: "Sign in to save to your wishlist.", requiresLogin: true };
  try {
    await addToWishlist(userId, productId);
    return { ok: true, saved: true };
  } catch (error) {
    return { ok: false, error: error instanceof AppError ? error.message : "Couldn't update your wishlist." };
  }
}

export async function removeFromWishlistAction(itemId: string): Promise<ActionResult> {
  const userId = await authedUserId();
  if (!userId) return SESSION_ERROR;
  try {
    await removeFromWishlist(userId, itemId);
    return { ok: true, message: "Removed from wishlist." };
  } catch (error) {
    return fail(error);
  }
}

/* ── notifications ────────────────────────────────────────────────────── */

export async function markNotificationReadAction(notificationId: string): Promise<ActionResult> {
  const userId = await authedUserId();
  if (!userId) return SESSION_ERROR;
  try {
    await markNotificationRead(userId, notificationId);
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

export async function markAllNotificationsReadAction(): Promise<ActionResult> {
  const userId = await authedUserId();
  if (!userId) return SESSION_ERROR;
  try {
    await markAllNotificationsRead(userId);
    return { ok: true, message: "All caught up." };
  } catch (error) {
    return fail(error);
  }
}

/* ── preferences ──────────────────────────────────────────────────────── */

export async function savePreferencesAction(_prev: unknown, formData: FormData): Promise<ActionResult> {
  const userId = await authedUserId();
  if (!userId) return SESSION_ERROR;
  const parsed = await parse(preferencesSchema, formData);
  if (!parsed.ok) return parsed.result;
  try {
    await savePreferences(userId, parsed.data);
    return { ok: true, message: "Preferences saved." };
  } catch (error) {
    return fail(error);
  }
}

/* ── email change ─────────────────────────────────────────────────────── */

export async function requestEmailChangeAction(_prev: unknown, formData: FormData): Promise<ActionResult> {
  const userId = await authedUserId();
  if (!userId) return SESSION_ERROR;
  const parsed = await parse(emailChangeRequestSchema, formData);
  if (!parsed.ok) return parsed.result;
  try {
    const { maskedTarget } = await requestEmailChange(userId, parsed.data.newEmail, await context());
    return { ok: true, message: `Confirmation link sent to ${maskedTarget}. It expires in 2 hours.` };
  } catch (error) {
    return fail(error);
  }
}

/* ── avatar ───────────────────────────────────────────────────────────── */

export async function uploadAvatarAction(_prev: unknown, formData: FormData): Promise<ActionResult> {
  const userId = await authedUserId();
  if (!userId) return SESSION_ERROR;

  const file = formData.get("avatar");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "Choose an image first." };
  }
  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    await uploadAvatar(userId, { name: file.name, type: file.type, size: buffer.length, data: buffer });
    return { ok: true, message: "Profile photo updated." };
  } catch (error) {
    return fail(error);
  }
}

export async function removeAvatarAction(): Promise<ActionResult> {
  const userId = await authedUserId();
  if (!userId) return SESSION_ERROR;
  try {
    await removeAvatar(userId);
    return { ok: true, message: "Profile photo removed." };
  } catch (error) {
    return fail(error);
  }
}

/* ── data export + deactivation ───────────────────────────────────────── */

export async function requestDataExportAction(): Promise<ActionResult> {
  const userId = await authedUserId();
  if (!userId) return SESSION_ERROR;
  try {
    const { ticketNumber } = await requestDataExport(userId);
    return { ok: true, message: `Export request logged (${ticketNumber}). We'll email you securely.` };
  } catch (error) {
    return fail(error);
  }
}

export async function deactivateAccountAction(_prev: unknown, formData: FormData): Promise<ActionResult> {
  const user = await getFreshUser();
  if (!user) return SESSION_ERROR;
  const parsed = await parse(deactivateAccountSchema, formData);
  if (!parsed.ok) return parsed.result;
  try {
    await deactivateAccount(user.id, parsed.data.password, parsed.data.reason, await context());
  } catch (error) {
    return fail(error);
  }
  // Stamp bumped server-side; sign the current device out too.
  await signOut({ redirectTo: "/?deactivated=1" });
  return { ok: true };
}
