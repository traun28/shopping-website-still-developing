import "dotenv/config";

async function main() {
  const { registerUser } = await import("@/services/auth.service");
  const { db, pool } = await import("@/db");
  const { users, products, orders } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");

  const email = "e2e.account@inkline.test";
  await db.delete(users).where(eq(users.email, email));
  const { userId } = await registerUser(
    { name: "Account Tester", email, phone: null, password: "Str0ngPassword!" },
    { ip: "198.51.100.9" },
  );
  console.log("USER registered:", userId);

  /* ─── Addresses ─── */
  const addrSvc = await import("@/services/address.service");
  const a1 = await addrSvc.createAddress(userId, {
    fullName: "Account Tester", phone: "9876543210", addressLine1: "1 Main St",
    city: "Bengaluru", state: "Karnataka", postalCode: "560001", country: "IN", addressType: "HOME", isDefaultShipping: false, isDefaultBilling: false,
  });
  const a2 = await addrSvc.createAddress(userId, {
    fullName: "Account Tester Office", phone: "9876543211", addressLine1: "22 Tech Park",
    city: "Mumbai", state: "Maharashtra", postalCode: "400001", country: "IN", addressType: "WORK", isDefaultShipping: false, isDefaultBilling: false,
  });
  const { addresses: ignoreMe } = await import("@/db/schema");
  void ignoreMe;
  let list = await addrSvc.listAddresses(userId);
  console.log("ADDRESSES created:", list.length, "| first is default (auto):", list[0].isDefault);
  await addrSvc.setDefaultAddress(userId, a2.address.id);
  list = await addrSvc.listAddresses(userId);
  const defaults = list.filter((a) => a.isDefault);
  console.log("DEFAULT flip:", defaults.length === 1 && defaults[0].id === a2.address.id ? "PASS" : "FAIL");

  /* ─── Wishlist (real DB product) ─── */
  const wlSvc = await import("@/services/wishlist.service");
  const [productRow] = await db.select().from(products).limit(1);
  const added1 = await wlSvc.addToWishlist(userId, productRow.id);
  const added2 = await wlSvc.addToWishlist(userId, productRow.id);
  const count = await wlSvc.wishlistCount(userId);
  console.log("WISHLIST: first add:", added1, "| dup add:", added2, "| count:", count, count === 1 && added1 && !added2 ? "PASS" : "FAIL");
  const entries = await wlSvc.listWishlist(userId);
  console.log("WISHLIST DTO:", entries[0].productName, "| price:", entries[0].minPricePaise, "| available:", entries[0].availability);
  await wlSvc.removeFromWishlist(userId, entries[0].itemId);
  console.log("WISHLIST after remove:", await wlSvc.wishlistCount(userId));

  /* ─── Notifications ─── */
  const notifSvc = await import("@/services/notification.service");
  const notifs = await notifSvc.listNotifications(userId);
  console.log("NOTIFICATIONS:", notifs.length, "| welcome exists:", notifs.some((n) => n.title === "Welcome to Inkline"));
  const unread = await notifSvc.unreadCount(userId);
  await notifSvc.markNotificationRead(userId, notifs[0].id);
  const unreadAfter = await notifSvc.unreadCount(userId);
  await notifSvc.markAllNotificationsRead(userId);
  const unreadFinal = await notifSvc.unreadCount(userId);
  console.log("NOTIFICATIONS read transitions:", unread, "→", unreadAfter, "→", unreadFinal, unreadFinal === 0 ? "PASS" : "FAIL");

  /* ─── Preferences ─── */
  const prefSvc = await import("@/services/preferences.service");
  const before = await prefSvc.getPreferences(userId);
  await prefSvc.savePreferences(userId, { marketingEmails: false, orderNotifications: true, promotionalNotifications: true, language: "hi-IN", currency: "INR", measurementSystem: "METRIC" });
  const after = await prefSvc.getPreferences(userId);
  console.log("PREFERENCES:", before.language, "→", after.language, "| promo:", after.promotionalNotifications ? "ON" : "OFF");

  /* ─── IDOR: another user's order must be invisible ─── */
  const ordSvc = await import("@/services/order.service");
  const [anyOrder] = await db.select().from(orders).limit(1);
  let idorResult = "no orders in db to test";
  if (anyOrder) {
    try {
      await ordSvc.getCustomerOrder(userId, anyOrder.id);
      idorResult = "FAIL — foreign order visible!";
    } catch {
      idorResult = "PASS — foreign order rejected";
    }
  }
  console.log("IDOR check:", idorResult);
  const myOrders = await ordSvc.listCustomerOrders(userId, { page: 1, pageSize: 10, offset: 0 });
  console.log("MY ORDERS list:", myOrders.total, "(0 expected for new customer)");

  await pool.end();
}
main().catch((e) => { console.error("E2E FAIL:", e.message ?? e); process.exit(1); });
