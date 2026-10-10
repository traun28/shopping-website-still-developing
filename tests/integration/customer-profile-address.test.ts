// @vitest-environment node
/** Part 15 — private profile, owner-scoped addresses, default consistency and consent history. */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const prefix = `account${randomBytes(5).toString("hex")}`;

let db: typeof import("@/db").db;
let schema: typeof import("@/db/schema");
let eq: typeof import("drizzle-orm").eq;
let inArray: typeof import("drizzle-orm").inArray;
let addresses: typeof import("@/services/address.service");
let profile: typeof import("@/services/profile.service");
let authService: typeof import("@/services/auth.service");
let preferences: typeof import("@/services/preferences.service");
let customerId: string;
let foreignUserId: string;

const baseAddress = {
  fullName: "Account Tester",
  phone: "+91 98765 43210",
  addressLine1: "14 Residency Road",
  addressLine2: "Flat 3B",
  locality: "Central Bengaluru",
  landmark: "Near Trinity Circle",
  deliveryInstructions: "Call on arrival",
  city: "Bengaluru",
  state: "Karnataka",
  postalCode: "560001",
  country: "IN",
  addressType: "HOME" as const,
  isDefaultShipping: true,
  isDefaultBilling: true,
};

describe.skipIf(!enabled)("customer profile and private address book (PostgreSQL)", () => {
  beforeAll(async () => {
    const [dbModule, schemaModule, drizzle, addressService, profileService, auth, preferenceService] = await Promise.all([
      import("@/db"),
      import("@/db/schema"),
      import("drizzle-orm"),
      import("@/services/address.service"),
      import("@/services/profile.service"),
      import("@/services/auth.service"),
      import("@/services/preferences.service"),
    ]);
    db = dbModule.db;
    schema = schemaModule;
    eq = drizzle.eq;
    inArray = drizzle.inArray;
    addresses = addressService;
    profile = profileService;
    authService = auth;
    preferences = preferenceService;

    const inserted = await db.insert(schema.users).values([
      { name: "Profile Tester", email: `${prefix}@example.test`, role: "CUSTOMER" },
      { name: "Foreign Tester", email: `${prefix}-foreign@example.test`, role: "CUSTOMER" },
    ]).returning({ id: schema.users.id });
    customerId = inserted[0]!.id;
    foreignUserId = inserted[1]!.id;
  });

  afterAll(async () => {
    if (!db || !schema || !customerId || !foreignUserId) return;
    await db.delete(schema.users).where(inArray(schema.users.id, [customerId, foreignUserId])).catch(() => undefined);
  });

  it("updates permitted profile fields without exposing credentials or changing verification", async () => {
    await authService.updateProfile(customerId, { name: "  Updated Customer  ", phone: "+1 (415) 555-0180" });
    const data = await profile.getCustomerProfile(customerId);
    expect(data.name).toBe("Updated Customer");
    expect(data.phone).toBe("+1 (415) 555-0180");
    expect(data.emailVerifiedAt).toBeNull();
    expect(data.completeness.missing).toContain("Verify your email");
    expect(Object.keys(data)).not.toContain("passwordHash");
    expect(Object.keys(data)).not.toContain("securityStamp");
  });

  it("keeps exactly one default per role, flags duplicates without merging and enforces ownership/versioning", async () => {
    const first = await addresses.createAddress(customerId, baseAddress);
    const second = await addresses.createAddress(customerId, {
      ...baseAddress,
      fullName: "Account Tester Office",
      addressType: "WORK",
      isDefaultShipping: false,
      isDefaultBilling: false,
    });
    expect(first.address.isDefault).toBe(true);
    expect(first.address.isDefaultBilling).toBe(true);
    expect(second.possibleDuplicate).toBe(true);
    expect(second.possibleDuplicateAddressId).toBe(first.address.id);

    await addresses.setDefaultShippingAddress(customerId, second.address.id);
    await addresses.setDefaultBillingAddress(customerId, second.address.id);
    let list = await addresses.listAddresses(customerId);
    expect(list.filter((row) => row.isDefault)).toHaveLength(1);
    expect(list.filter((row) => row.isDefaultBilling)).toHaveLength(1);
    expect(list.find((row) => row.id === second.address.id)?.isDefault).toBe(true);
    expect(list.find((row) => row.id === second.address.id)?.isDefaultBilling).toBe(true);
    const firstAfterDefaultChanges = await addresses.getAddress(customerId, first.address.id);
    const secondAfterDefaultChanges = await addresses.getAddress(customerId, second.address.id);
    expect(firstAfterDefaultChanges.version).toBe(first.address.version + 2);
    expect(secondAfterDefaultChanges.version).toBe(second.address.version + 2);

    const updated = await addresses.updateAddress(customerId, second.address.id, {
      addressLine1: "22 Tech Park Avenue",
    }, { expectedVersion: secondAfterDefaultChanges.version });
    expect(updated.address.version).toBe(secondAfterDefaultChanges.version + 1);
    expect(updated.address.addressLine1).toBe("22 Tech Park Avenue");
    await expect(addresses.updateAddress(customerId, second.address.id, { city: "Mysuru" }, {
      expectedVersion: second.address.version,
    })).rejects.toMatchObject({ code: "ADDRESS_VERSION_CONFLICT" });

    await expect(addresses.getAddress(foreignUserId, first.address.id)).rejects.toMatchObject({ status: 404 });
    await expect(addresses.updateAddress(foreignUserId, first.address.id, { city: "Mysuru" }))
      .rejects.toMatchObject({ status: 404 });
    await expect(addresses.deleteAddress(foreignUserId, first.address.id)).rejects.toMatchObject({ status: 404 });

    await addresses.deleteAddress(customerId, second.address.id, { expectedVersion: updated.address.version });
    list = await addresses.listAddresses(customerId);
    expect(list.some((row) => row.id === second.address.id)).toBe(false);
    expect(list.some((row) => row.isDefault)).toBe(false);
    expect(list.some((row) => row.isDefaultBilling)).toBe(false);
    expect((await profile.getCustomerProfile(customerId)).hasDefaultShippingAddress).toBe(false);
  });

  it("records explicit marketing consent changes separately from transactional preferences", async () => {
    await preferences.savePreferences(customerId, {
      marketingEmails: false,
      orderNotifications: true,
      promotionalNotifications: true,
      language: "hi-IN",
      currency: "INR",
      measurementSystem: "METRIC",
    });
    let events = await db.select().from(schema.marketingConsentEvents)
      .where(eq(schema.marketingConsentEvents.userId, customerId));
    expect(events).toHaveLength(0);

    await preferences.savePreferences(customerId, {
      marketingEmails: true,
      orderNotifications: true,
      promotionalNotifications: false,
      language: "en-IN",
      currency: "INR",
      measurementSystem: "IMPERIAL",
    });
    await preferences.savePreferences(customerId, {
      marketingEmails: false,
      orderNotifications: true,
      promotionalNotifications: true,
      language: "hi-IN",
      currency: "INR",
      measurementSystem: "METRIC",
    });
    events = await db.select().from(schema.marketingConsentEvents)
      .where(eq(schema.marketingConsentEvents.userId, customerId));
    expect(events.map((event) => event.consented)).toEqual([true, false]);
    expect(events.every((event) => event.source === "ACCOUNT_SETTINGS" && event.policyVersion.length > 0)).toBe(true);
  });
});
