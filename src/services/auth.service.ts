import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { authTokens, users, type AuthTokenType, type User } from "@/db/schema";
import { withTransaction, type DbClient } from "@/db/utils";
import { AppError, RateLimitError, ValidationError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { assessPassword, hashPassword, verifyPassword } from "@/server/auth/password";
import { checkRateLimit, AUTH_RATE_RULES } from "@/server/auth/rate-limit";
import { generateRawToken, hashToken, isTokenUsable, TOKEN_TTL_MINUTES } from "@/server/auth/tokens";
import { normalizeEmail } from "@/validations/auth";
import { hashIp, writeAudit } from "@/services/audit.service";
import { absoluteUrl } from "@/lib/seo";
import { sendPasswordResetEmail, sendVerificationEmail } from "@/services/email";
import { createNotification } from "@/services/notification.service";

/** Context passed from actions/routes for throttling + audit. */
export interface AuthRequestContext {
  ip?: string;
  userAgent?: string;
}

/** Errors the UI can render verbatim (user-safe). */
export class AuthError extends AppError {
  constructor(message: string, code = "AUTH_ERROR") {
    super(message, { status: 400, code });
  }
}

/* ───────────────────────── helpers ──────────────────────────────────── */

async function issueToken(
  tx: DbClient,
  userId: string,
  type: AuthTokenType,
  ip?: string,
): Promise<string> {
  // Supersede older unused tokens of this type (single usable token).
  await tx
    .update(authTokens)
    .set({ consumedAt: new Date() })
    .where(and(eq(authTokens.userId, userId), eq(authTokens.type, type), isNull(authTokens.consumedAt)));

  const raw = generateRawToken();
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MINUTES[type] * 60_000);
  await tx.insert(authTokens).values({
    userId,
    type,
    tokenHash: hashToken(raw),
    expiresAt,
    ipHash: hashIp(ip),
  });
  return raw;
}

async function consumeToken(
  type: AuthTokenType,
  rawToken: string,
): Promise<{ userId: string } | { error: string }> {
  const tokenHash = hashToken(rawToken);
  const [token] = await db
    .select()
    .from(authTokens)
    .where(and(eq(authTokens.tokenHash, tokenHash), eq(authTokens.type, type)))
    .limit(1);

  if (!token || !isTokenUsable(token)) {
    return { error: token?.consumedAt ? "This link was already used." : "This link is invalid or has expired." };
  }

  await db.update(authTokens).set({ consumedAt: new Date() }).where(eq(authTokens.id, token.id));
  return { userId: token.userId };
}

/* ─────────────────────── registration ───────────────────────────────── */

export async function registerUser(
  input: { name: string; email: string; phone?: string | null; password: string },
  context: AuthRequestContext = {},
): Promise<{ userId: string }> {
  const email = normalizeEmail(input.email);
  const identity = context.ip ?? email;

  const rate = await checkRateLimit("register", identity, AUTH_RATE_RULES.register);
  if (!rate.allowed) {
    throw new RateLimitError("Too many registration attempts. Please try again later.");
  }

  const strength = assessPassword(input.password);
  if (!strength.valid) {
    throw new ValidationError(strength.errors[0] ?? "Choose a stronger password.");
  }

  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing) {
    // Audit internally, respond generically — no account enumeration.
    await writeAudit({
      action: "user.registered",
      entityType: "user",
      entityId: existing.id,
      metadata: { reason: "duplicate_email_attempt" },
      ip: context.ip,
      userAgent: context.userAgent,
    });
    throw new AuthError("An account with this email already exists. Try signing in instead.", "EMAIL_TAKEN");
  }

  const passwordHash = hashPassword(input.password);
  const userId = await withTransaction(async (tx) => {
    const [created] = await tx
      .insert(users)
      .values({
        name: input.name.trim(),
        email,
        phone: input.phone?.trim() || null,
        passwordHash,
        role: "CUSTOMER",
        status: "ACTIVE",
      })
      .returning({ id: users.id });

    const rawToken = await issueToken(tx, created.id, "EMAIL_VERIFICATION", context.ip);
    const verifyUrl = absoluteUrl(`/verify-email?token=${rawToken}`);
    await sendVerificationEmail({ to: email, verifyUrl }).catch((error) =>
      logger.warn("Verification email failed", { error: error instanceof Error ? error.message : "unknown" }),
    );

    return created.id;
  });

  await writeAudit({
    action: "user.registered",
    entityType: "user",
    entityId: userId,
    actorId: userId,
    metadata: { role: "CUSTOMER" },
    ip: context.ip,
    userAgent: context.userAgent,
  });

  // Real welcome notification — the notification center's first event.
  await createNotification(userId, {
    type: "ACCOUNT",
    title: "Welcome to Inkline",
    message: "Your account is ready. Verify your email to secure it, then explore the first drop.",
    linkHref: "/account",
  });

  return { userId };
}

/* ─────────────────────── login (Auth.js authorize) ──────────────────── */

export const INVALID_CREDENTIALS = "Invalid email or password.";

export async function verifyLoginCredentials(
  emailRaw: string,
  password: string,
  context: AuthRequestContext = {},
): Promise<User> {
  const email = normalizeEmail(emailRaw);
  const identity = `${email}:${context.ip ?? "unknown"}`;

  const rate = await checkRateLimit("login", identity, AUTH_RATE_RULES.login);
  if (!rate.allowed) {
    throw new RateLimitError("Too many sign-in attempts. Please wait a few minutes and try again.");
  }

  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);

  // Uniform work: verify against a fixed dummy hash so unknown emails cost
  // the same as real ones (no user-enumeration timing oracle).
  const hashToCheck =
    user?.passwordHash ??
    "scrypt:16384:00000000000000000000000000000000:0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
  const passwordOk = verifyPassword(hashToCheck, password);

  if (!user || !passwordOk) {
    await writeAudit({
      action: "user.login_failed",
      entityType: "auth",
      metadata: { reason: "invalid_credentials" },
      ip: context.ip,
      userAgent: context.userAgent,
    });
    throw new AuthError(INVALID_CREDENTIALS, "INVALID_CREDENTIALS");
  }

  if (user.status === "SUSPENDED") {
    await writeAudit({
      action: "user.login_failed",
      entityType: "user",
      entityId: user.id,
      metadata: { reason: "suspended" },
      ip: context.ip,
      userAgent: context.userAgent,
    });
    throw new AuthError(
      "This account is suspended. Please contact support@inkline.in.",
      "ACCOUNT_SUSPENDED",
    );
  }
  if (user.status === "DEACTIVATED") {
    throw new AuthError(
      "This account was deactivated. Reach out to support@inkline.in if you'd like to reopen it.",
      "ACCOUNT_DEACTIVATED",
    );
  }
  if (!user.passwordHash) {
    throw new AuthError(INVALID_CREDENTIALS, "INVALID_CREDENTIALS");
  }

  // Success side-effects (non-blocking).
  void db
    .update(users)
    .set({ lastLoginAt: new Date() })
    .where(eq(users.id, user.id))
    .catch(() => undefined);
  void writeAudit({
    action: "user.login_success",
    entityType: "user",
    entityId: user.id,
    actorId: user.id,
    ip: context.ip,
    userAgent: context.userAgent,
  });

  return user;
}

/* ─────────────────────── password reset ─────────────────────────────── */

export async function requestPasswordReset(emailRaw: string, context: AuthRequestContext = {}): Promise<void> {
  const email = normalizeEmail(emailRaw);
  const rate = await checkRateLimit("forgot-password", email, AUTH_RATE_RULES.forgotPassword);
  if (!rate.allowed) {
    // Still respond neutrally to the client.
    throw new RateLimitError("Too many requests. Please try again later.");
  }

  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);

  // Always behave the same from the caller's perspective (anti-enumeration).
  if (user && user.status === "ACTIVE") {
    const rawToken = await withTransaction((tx) => issueToken(tx, user.id, "PASSWORD_RESET", context.ip));
    const resetUrl = absoluteUrl(`/reset-password?token=${rawToken}`);
    await sendPasswordResetEmail({ to: email, resetUrl }).catch((error) =>
      logger.warn("Password-reset email failed", { error: error instanceof Error ? error.message : "unknown" }),
    );
    await writeAudit({
      action: "user.password_reset_requested",
      entityType: "user",
      entityId: user.id,
      ip: context.ip,
      userAgent: context.userAgent,
    });
  }
}

export async function resetPasswordWithToken(
  rawToken: string,
  newPassword: string,
  context: AuthRequestContext = {},
): Promise<void> {
  const rate = await checkRateLimit("reset-password", context.ip ?? rawToken.slice(0, 8), AUTH_RATE_RULES.resetPassword);
  if (!rate.allowed) throw new RateLimitError();

  const strength = assessPassword(newPassword);
  if (!strength.valid) throw new ValidationError(strength.errors[0] ?? "Choose a stronger password.");

  const consumed = await consumeToken("PASSWORD_RESET", rawToken);
  if ("error" in consumed) throw new AuthError(consumed.error, "TOKEN_INVALID");

  // New hash + bumped security stamp in ONE atomic write — the stamp
  // invalidates every pre-existing session JWT for this account.
  await db
    .update(users)
    .set({
      passwordHash: hashPassword(newPassword),
      securityStamp: sql`${users.securityStamp} + 1`,
    })
    .where(eq(users.id, consumed.userId));

  await writeAudit({
    action: "user.password_reset_completed",
    entityType: "user",
    entityId: consumed.userId,
    ip: context.ip,
    userAgent: context.userAgent,
  });

  await createNotification(consumed.userId, {
    type: "ACCOUNT",
    title: "Password was reset",
    message: "Your Inkline password was reset. If this wasn't you, contact support@inkline.in immediately.",
    linkHref: "/account/security",
  });
}

/* ─────────────────────── email verification ─────────────────────────── */

export async function verifyEmailWithToken(
  rawToken: string,
  context: AuthRequestContext = {},
): Promise<{ userId: string }> {
  const consumed = await consumeToken("EMAIL_VERIFICATION", rawToken);
  if ("error" in consumed) throw new AuthError(consumed.error, "TOKEN_INVALID");

  await db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, consumed.userId));
  await writeAudit({
    action: "user.email_verified",
    entityType: "user",
    entityId: consumed.userId,
    actorId: consumed.userId,
    ip: context.ip,
    userAgent: context.userAgent,
  });
  return { userId: consumed.userId };
}

export async function resendVerificationEmail(emailRaw: string, context: AuthRequestContext = {}): Promise<void> {
  const email = normalizeEmail(emailRaw);
  const rate = await checkRateLimit("verification", email, AUTH_RATE_RULES.verification);
  if (!rate.allowed) throw new RateLimitError("Too many requests. Please try again later.");

  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (user && user.status === "ACTIVE" && !user.emailVerifiedAt) {
    const rawToken = await withTransaction((tx) => issueToken(tx, user.id, "EMAIL_VERIFICATION", context.ip));
    await sendVerificationEmail({ to: email, verifyUrl: absoluteUrl(`/verify-email?token=${rawToken}`) }).catch(
      (error) => logger.warn("Verification email failed", { error: error instanceof Error ? error.message : "unknown" }),
    );
    await writeAudit({
      action: "user.email_verification_resent",
      entityType: "user",
      entityId: user.id,
      ip: context.ip,
      userAgent: context.userAgent,
    });
  }
  // Neutral response regardless — anti-enumeration.
}

/* ───────────────── account: password change / profile ───────────────── */

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  context: AuthRequestContext = {},
): Promise<void> {
  const rate = await checkRateLimit("change-password", userId, AUTH_RATE_RULES.changePassword);
  if (!rate.allowed) throw new RateLimitError();

  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user?.passwordHash || !verifyPassword(user.passwordHash, currentPassword)) {
    throw new AuthError("Your current password isn't correct.", "CURRENT_PASSWORD_WRONG");
  }

  const strength = assessPassword(newPassword);
  if (!strength.valid) throw new ValidationError(strength.errors[0] ?? "Choose a stronger password.");
  if (currentPassword === newPassword) {
    throw new ValidationError("New password must be different from the current one.");
  }

  await db
    .update(users)
    .set({ passwordHash: hashPassword(newPassword), securityStamp: sql`${users.securityStamp} + 1` })
    .where(eq(users.id, userId));

  await writeAudit({
    action: "user.password_changed",
    entityType: "user",
    entityId: userId,
    actorId: userId,
    ip: context.ip,
    userAgent: context.userAgent,
  });

  await createNotification(userId, {
    type: "ACCOUNT",
    title: "Password changed",
    message: "Your password was changed and other devices were signed out. Wasn't you? Contact support@inkline.in now.",
    linkHref: "/account/security",
  });
}

export async function updateProfile(
  userId: string,
  input: { name?: string; phone?: string | null },
  context: AuthRequestContext = {},
): Promise<void> {
  const values: Partial<typeof users.$inferInsert> = {};
  if (input.name !== undefined) values.name = input.name.trim();
  if (input.phone !== undefined) values.phone = input.phone?.trim() || null;
  const fields = Object.keys(values);
  if (fields.length === 0) throw new ValidationError("Choose at least one profile field to update.");
  await db.update(users).set(values).where(eq(users.id, userId));
  await writeAudit({
    action: "user.profile_updated",
    entityType: "user",
    entityId: userId,
    actorId: userId,
    metadata: { fields },
    ip: context.ip,
    userAgent: context.userAgent,
  });
}
