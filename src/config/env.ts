import "server-only";
import { z } from "zod";

/**
 * Validated, grouped server-side environment configuration.
 *
 * Rules enforced here:
 *  - Secrets NEVER ship to the browser (this module is server-only).
 *  - Validation is lazy and memoized so `next build` can compile routes
 *    without every optional secret being present.
 *  - When a required variable is missing, the thrown error lists exactly
 *    which variables are absent — without dumping their values.
 */

const bool = z
  .string()
  .optional()
  .transform((v) => v === "true" || v === "1");

const serverSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // Application
  NEXT_PUBLIC_APP_URL: z.string().min(1).default("http://localhost:3000"),

  // Database
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  // Authentication (wired up in the auth milestone)
  AUTH_SECRET: z.string().optional(),
  AUTH_URL: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  // Payments — Razorpay (primary, India)
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  NEXT_PUBLIC_RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  // Payments — Stripe (future, international)
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: z.string().optional(),

  // POD supplier integration
  POD_PROVIDER: z.string().optional(),
  POD_API_BASE_URL: z.string().optional(),
  POD_API_KEY: z.string().optional(),
  POD_API_SECRET: z.string().optional(),
  POD_WEBHOOK_SECRET: z.string().optional(),

  // Object storage (S3-compatible)
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  NEXT_PUBLIC_CDN_URL: z.string().optional(),

  // Transactional email
  EMAIL_FROM: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.string().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),

  // Analytics & monitoring
  NEXT_PUBLIC_GA_MEASUREMENT_ID: z.string().optional(),
  SENTRY_DSN: z.string().optional(),

  // Cart lifecycle (guest sessions expire sooner than account carts).
  CART_GUEST_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  CART_USER_TTL_DAYS: z.coerce.number().int().min(1).max(730).default(180),
  CART_ABANDONMENT_MINUTES: z.coerce.number().int().min(5).max(43_200).default(60),

  // Checkout preparation sessions expire; no inventory is reserved.
  CHECKOUT_SESSION_TTL_MINUTES: z.coerce.number().int().min(5).max(240).default(45),
  CHECKOUT_PII_RETENTION_DAYS: z.coerce.number().int().min(7).max(365).default(30),

  // Ops
  CRON_SECRET: z.string().optional(),
  IP_HASH_SALT: z.string().optional(),

  FEATURE_POD_LIVE: bool,
});

export type ServerEnv = z.infer<typeof serverSchema>;

let cached: ServerEnv | null = null;

/**
 * Parse and return the validated server environment.
 * Throws a readable error when required variables are missing.
 */
export function serverEnv(): ServerEnv {
  if (cached) return cached;
  const parsed = serverSchema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(
      `Invalid or missing environment variables:\n${missing}\nCheck .env against .env.example.`,
    );
  }
  cached = parsed.data;
  return cached;
}

/** Convenience accessors */
export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/** Which external integrations have real credentials configured. */
export function integrations() {
  const env = serverEnv();
  return {
    database: Boolean(env.DATABASE_URL),
    auth: Boolean(env.AUTH_SECRET),
    razorpay: Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET),
    stripe: Boolean(env.STRIPE_SECRET_KEY),
    pod: Boolean(env.POD_API_KEY && env.POD_API_BASE_URL),
    storage: Boolean(env.S3_BUCKET && env.S3_ACCESS_KEY_ID),
    email: Boolean(env.RESEND_API_KEY || env.SMTP_HOST),
    analytics: Boolean(env.NEXT_PUBLIC_GA_MEASUREMENT_ID),
  } as const;
}
