import { z } from "zod";
import { emailSchema } from "@/validations/auth";
import { addressSchema } from "@/validations/address";

const checkoutPhoneSchema = z
  .string()
  .trim()
  .min(7, "Enter a contact number.")
  .max(32, "That phone number looks too long.")
  .regex(/^[+]?[0-9][0-9 .()-]{5,30}$/, "Enter a valid contact number.");

export const checkoutContactSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: emailSchema,
  phone: checkoutPhoneSchema,
}).strict();

export const checkoutAddressSelectionSchema = z.object({
  expectedVersion: z.number().int().positive(),
  shippingAddressId: z.uuid().nullable().optional(),
  shippingAddress: addressSchema.optional(),
  billingSameAsShipping: z.boolean(),
  billingAddressId: z.uuid().nullable().optional(),
  billingAddress: addressSchema.optional(),
}).strict();

export const checkoutDeliverySelectionSchema = z.object({
  expectedVersion: z.number().int().positive(),
  deliveryMethodId: z.string().trim().min(1).max(120),
}).strict();

export const checkoutRevalidateSchema = z.object({
  expectedVersion: z.number().int().positive(),
  acknowledgeCartChanges: z.boolean().default(false),
}).strict();

export const checkoutCouponSchema = z.object({
  expectedVersion: z.number().int().positive(),
  code: z.string().trim().min(3).max(64),
}).strict();

export const checkoutCouponRemovalSchema = z.object({
  expectedVersion: z.number().int().positive(),
}).strict();

export const checkoutCancelSchema = z.object({
  expectedVersion: z.number().int().positive(),
}).strict();

export type CheckoutContactInput = z.infer<typeof checkoutContactSchema>;
export type CheckoutAddressSelectionInput = z.infer<typeof checkoutAddressSelectionSchema>;
export type CheckoutDeliverySelectionInput = z.infer<typeof checkoutDeliverySelectionSchema>;
export type CheckoutRevalidateInput = z.infer<typeof checkoutRevalidateSchema>;
