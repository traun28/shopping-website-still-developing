import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { addresses, users } from "@/db/schema";
import { NotFoundError } from "@/lib/errors";

export interface CustomerProfileDTO {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  avatarUrl: string | null;
  emailVerifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  hasDefaultShippingAddress: boolean;
  completeness: {
    percent: number;
    completed: number;
    total: number;
    missing: string[];
  };
}

/** Private profile DTO; auth/security internals are deliberately omitted. */
export async function getCustomerProfile(userId: string): Promise<CustomerProfileDTO> {
  const [[user], [defaultAddress]] = await Promise.all([
    db.select({
      id: users.id,
      name: users.name,
      email: users.email,
      phone: users.phone,
      avatarUrl: users.avatarUrl,
      emailVerifiedAt: users.emailVerifiedAt,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
    }).from(users).where(eq(users.id, userId)).limit(1),
    db.select({ id: addresses.id }).from(addresses).where(and(eq(addresses.userId, userId), eq(addresses.isDefault, true))).limit(1),
  ]);
  if (!user) throw new NotFoundError("Account not found.");

  const completedChecks = [
    user.name.trim().length >= 2,
    Boolean(user.emailVerifiedAt),
    Boolean(defaultAddress),
  ];
  const missing = [
    !completedChecks[0] ? "Add your name" : null,
    !completedChecks[1] ? "Verify your email" : null,
    !completedChecks[2] ? "Choose a default shipping address" : null,
  ].filter((item): item is string => Boolean(item));
  const completed = completedChecks.filter(Boolean).length;

  return {
    ...user,
    hasDefaultShippingAddress: Boolean(defaultAddress),
    completeness: {
      completed,
      total: completedChecks.length,
      percent: Math.round((completed / completedChecks.length) * 100),
      missing,
    },
  };
}
