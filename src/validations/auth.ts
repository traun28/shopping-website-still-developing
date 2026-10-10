import { z } from "zod";

/**
 * Authentication form schemas — shared by client UX and server actions.
 * Server-side validation is the enforcement point; the client mirrors it
 * purely for feedback speed.
 */

export const emailSchema = z
  .string()
  .trim()
  .min(3, "Enter your email address.")
  .max(254, "That email address looks too long.")
  .pipe(z.email({ message: "Enter a valid email address." }));

export const phoneSchema = z
  .string()
  .trim()
  .regex(/^(\+91[\s-]?[6-9]\d{9}|[6-9]\d{9})?$/, "Enter a valid 10-digit Indian mobile number.")
  .optional()
  .or(z.literal(""));

/** International display/contact number; verification stays on its secure flow. */
export const internationalPhoneSchema = z
  .string()
  .trim()
  .max(32, "That phone number looks too long.")
  .regex(/^$|^[+]?[0-9][0-9 .()-]{5,30}$/, "Enter a valid international phone number.")
  .optional()
  .or(z.literal(""));

export const passwordSchema = z
  .string()
  .min(10, "Use at least 10 characters.")
  .max(128, "Keep it under 128 characters.");

export const registerSchema = z
  .object({
    name: z.string().trim().min(2, "Enter your full name.").max(80, "Keep it under 80 characters."),
    email: emailSchema,
    phone: phoneSchema,
    password: passwordSchema,
    confirmPassword: z.string(),
    acceptTerms: z.literal(true, { message: "Please accept the terms to continue." }),
  })
  .refine((values) => values.password === values.confirmPassword, {
    message: "Passwords don't match.",
    path: ["confirmPassword"],
  });

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Enter your password."),
});

export const forgotPasswordSchema = z.object({
  email: emailSchema,
});

export const resetPasswordSchema = z
  .object({
    token: z.string().min(20, "Reset link looks incomplete."),
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((values) => values.password === values.confirmPassword, {
    message: "Passwords don't match.",
    path: ["confirmPassword"],
  });

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Enter your current password."),
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((values) => values.password === values.confirmPassword, {
    message: "Passwords don't match.",
    path: ["confirmPassword"],
  });

export const profileUpdateSchema = z.object({
  name: z.string().trim().min(2, "Enter your full name.").max(80, "Keep it under 80 characters."),
  phone: internationalPhoneSchema,
});

export const profilePatchSchema = profileUpdateSchema.partial().strict().refine(
  (value) => Object.keys(value).length > 0,
  "Choose at least one profile field to update.",
);

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type ProfileUpdateInput = z.infer<typeof profileUpdateSchema>;

/** Normalizes an email for uniqueness checks + storage. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
