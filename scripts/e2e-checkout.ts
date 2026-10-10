import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";

const root = process.cwd();
const port = Number(process.env.CHECKOUT_E2E_PORT ?? 3189);
const baseUrl = `http://127.0.0.1:${port}`;
const authSecret = process.env.AUTH_SECRET ?? "checkout-e2e-only-secret-not-for-production";
let output = "";
let guestCookie: string | null = null;

type Envelope = {
  ok?: boolean;
  data?: Record<string, unknown>;
  error?: { code?: string; message?: string };
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function rememberOutput(chunk: Buffer | string) {
  output = `${output}${chunk.toString()}`.slice(-12_000);
}

async function findPurchasableVariant() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required; run via npm run e2e:checkout.");
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const result = await client.query<{ product_id: string; variant_id: string }>(`
      SELECT p.id AS product_id, v.id AS variant_id
        FROM products p
        JOIN product_variants v ON v.product_id = p.id
        LEFT JOIN users seller ON seller.id = p.seller_id
       WHERE p.status = 'ACTIVE'
         AND p.visibility = 'PUBLIC'
         AND (p.seller_id IS NULL OR seller.status = 'ACTIVE')
         AND v.is_active = true
         AND v.stock_quantity - v.reserved_quantity >= 2
       ORDER BY p.slug, v.sku
       LIMIT 1
    `);
    const row = result.rows[0];
    if (!row) throw new Error("No seeded purchasable variant with two available units was found.");
    return row;
  } finally {
    await client.end();
  }
}

async function setPriceAndReduceStock(variantId: string) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required.");
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query("UPDATE product_variants SET price = price + 500 WHERE id = $1", [variantId]);
    await client.query("UPDATE product_variants SET stock_quantity = reserved_quantity + 1 WHERE id = $1", [variantId]);
  } finally {
    await client.end();
  }
}

async function main() {
  const { product_id: productId, variant_id: variantId } = await findPurchasableVariant();
  const server = spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: root,
      env: { ...process.env, AUTH_SECRET: authSecret },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server.stdout.on("data", rememberOutput);
  server.stderr.on("data", rememberOutput);

  try {
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (server.exitCode !== null) throw new Error(`Next.js exited before readiness (code ${server.exitCode}).\n${output}`);
      try {
        const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(2_000) });
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {
        // Next.js may still be compiling its first route.
      }
      await delay(500);
    }
    assert(ready, `Timed out waiting for Next.js.\n${output}`);

    const request = async (
      path: string,
      method: string,
      body?: unknown,
      key?: string,
      origin = baseUrl,
      cookieOverride?: string | null,
    ) => {
      const headers = new Headers({ Origin: origin });
      if (body !== undefined) headers.set("Content-Type", "application/json");
      const cookie = cookieOverride === undefined ? guestCookie : cookieOverride;
      if (cookie) headers.set("Cookie", cookie);
      if (key) headers.set("Idempotency-Key", key);
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const payload = (await response.json()) as Envelope;
      const setCookie = response.headers.getSetCookie()
        .find((value) => value.startsWith("inkline_cart_session=")) ?? null;
      if (setCookie) guestCookie = setCookie.split(";")[0] ?? null;
      return { response, payload, setCookie };
    };

    const csrf = await request("/api/checkout/session", "POST", {}, "checkout-e2e-csrf-0001", "https://attacker.invalid");
    assert(csrf.response.status === 403, `Cross-origin checkout mutation was not rejected (HTTP ${csrf.response.status}).`);

    const added = await request("/api/cart/items", "POST", {
      productId,
      variantId,
      quantity: 1,
      source: "PRODUCT_PAGE",
    }, "checkout-e2e-cart-0001");
    assert(added.response.ok && added.payload.data, `Could not add a real catalog variant: ${JSON.stringify(added.payload)}`);
    assert(guestCookie?.startsWith("inkline_cart_session="), "The guest cart session cookie was not retained.");
    assert(added.setCookie?.includes("HttpOnly") && added.setCookie.includes("SameSite=Lax"), "Guest cookie is missing secure browser attributes.");

    const checkoutPage = await fetch(`${baseUrl}/checkout`, { headers: { Cookie: guestCookie! } });
    assert(checkoutPage.ok, `The checkout route failed (HTTP ${checkoutPage.status}).`);

    const started = await request("/api/checkout/session", "POST", {}, "checkout-e2e-start-0001");
    assert(started.response.ok && started.payload.data, `Checkout could not start: ${JSON.stringify(started.payload)}`);
    let session = started.payload.data;
    const sessionId = String(session.id);
    assert(session.status === "NEEDS_ATTENTION" && session.isReady === false, "Unconfigured integrations must never yield READY.");
    const startIssues = session.issues as Array<{ code: string }>;
    assert(startIssues.some((issue) => issue.code === "DELIVERY_UNAVAILABLE"), "Missing shipping integration was not reported.");
    assert(startIssues.some((issue) => issue.code === "TAX_NOT_CONFIGURED"), "Missing tax provider was not reported.");
    assert((session.totals as Record<string, unknown>).shippingPaise === null, "The checkout invented a delivery amount.");
    assert((session.totals as Record<string, unknown>).totalEstimatePaise === null, "The checkout displayed a final total without authoritative shipping.");

    const contact = await request(`/api/checkout/session/${sessionId}/contact`, "PATCH", {
      expectedVersion: session.version,
      contact: { name: "Checkout Guest", email: "checkout-guest@example.test", phone: "+91 98765 43210" },
    }, "checkout-e2e-contact-01");
    assert(contact.response.ok && contact.payload.data, `Guest contact update failed: ${JSON.stringify(contact.payload)}`);
    session = contact.payload.data;

    const address = await request(`/api/checkout/session/${sessionId}/address`, "PATCH", {
      expectedVersion: session.version,
      shippingAddress: {
        fullName: "Checkout Guest",
        phone: "+91 98765 43210",
        addressLine1: "14 Residency Road",
        addressLine2: "",
        locality: "Central Bengaluru",
        landmark: "Near Trinity Circle",
        deliveryInstructions: "Call on arrival",
        city: "Bengaluru",
        state: "Karnataka",
        postalCode: "560001",
        country: "IN",
        addressType: "HOME",
        isDefaultShipping: false,
        isDefaultBilling: false,
      },
      billingSameAsShipping: true,
    }, "checkout-e2e-address-01");
    assert(address.response.ok && address.payload.data, `Guest address update failed: ${JSON.stringify(address.payload)}`);
    session = address.payload.data;
    assert((session.shippingAddress as Record<string, unknown>).source === "INLINE", "Guest address was not kept in the private checkout snapshot.");
    assert(session.billingSameAsShipping === true, "Billing did not follow the selected shipping address.");

    const delivery = await request(`/api/checkout/session/${sessionId}/delivery-options`, "GET");
    assert(delivery.response.ok && delivery.payload.data, `Delivery options could not be read: ${JSON.stringify(delivery.payload)}`);
    assert(delivery.payload.data.status === "NOT_CONFIGURED" && (delivery.payload.data.options as unknown[]).length === 0, "No delivery provider should mean no invented methods or rates.");
    const inventedDelivery = await request(`/api/checkout/session/${sessionId}/delivery`, "PATCH", {
      expectedVersion: session.version,
      deliveryMethodId: "invented-flat-rate",
    }, "checkout-e2e-delivery-01");
    assert(inventedDelivery.response.status === 409 && inventedDelivery.payload.error?.code === "DELIVERY_UNAVAILABLE", "An unsupported delivery method was accepted.");

    const cartRead = await request("/api/cart", "GET");
    assert(cartRead.response.ok && cartRead.payload.data, `Cart could not be re-read: ${JSON.stringify(cartRead.payload)}`);
    const cart = cartRead.payload.data;
    const lines = cart.items as Array<Record<string, unknown>>;
    assert(lines[0], "The real cart line disappeared before checkout revalidation.");
    const cartChange = await request(`/api/cart/items/${String(lines[0].id)}`, "PATCH", {
      quantity: 2,
      cartVersion: cart.version,
    }, "checkout-e2e-cart-update");
    assert(cartChange.response.ok, `Could not simulate another-tab cart change: ${JSON.stringify(cartChange.payload)}`);

    const stale = await request(`/api/checkout/session/${sessionId}/summary`, "GET");
    assert(stale.response.ok && stale.payload.data, `Checkout summary failed: ${JSON.stringify(stale.payload)}`);
    session = stale.payload.data;
    assert((session.issues as Array<{ code: string }>).some((issue) => issue.code === "CART_CHANGED"), "Checkout did not detect the newer cart version.");

    const reviewed = await request(`/api/checkout/session/${sessionId}/revalidate`, "POST", {
      expectedVersion: session.version,
      acknowledgeCartChanges: true,
    }, "checkout-e2e-review-01");
    assert(reviewed.response.ok && reviewed.payload.data, `Cart review could not be revalidated: ${JSON.stringify(reviewed.payload)}`);
    session = reviewed.payload.data;
    assert(!(session.issues as Array<{ code: string }>).some((issue) => issue.code === "CART_CHANGED"), "Review did not acknowledge the current cart version.");

    await setPriceAndReduceStock(variantId);
    const changedPrice = await request(`/api/checkout/session/${sessionId}/summary`, "GET");
    assert(changedPrice.response.ok && changedPrice.payload.data, `Price revalidation failed: ${JSON.stringify(changedPrice.payload)}`);
    session = changedPrice.payload.data;
    assert((session.issues as Array<{ code: string }>).some((issue) => issue.code === "PRICE_CHANGED"), "Checkout did not surface the authoritative price change.");
    assert(session.isReady === false, "Checkout became ready after a price change without the required integrations.");

    const foreignToken = randomBytes(32).toString("base64url");
    const foreignRead = await request(`/api/checkout/session/${sessionId}`, "GET", undefined, undefined, baseUrl, `inkline_cart_session=${foreignToken}`);
    assert(foreignRead.response.status === 403 && foreignRead.payload.error?.code === "CHECKOUT_ACCESS_DENIED", "A foreign guest cookie accessed the checkout session.");

    const cancelled = await request(`/api/checkout/session/${sessionId}/cancel`, "POST", {
      expectedVersion: session.version,
    }, "checkout-e2e-cancel-01");
    assert(cancelled.response.ok && cancelled.payload.data?.status === "CANCELLED", `Checkout cancellation failed: ${JSON.stringify(cancelled.payload)}`);

    console.log("✓ HTTP checkout flow: guest cart, owner-scoped session, contact/address, no fake delivery, cart-version conflict, price change, foreign-guest rejection and cancellation. READY correctly remains blocked without shipping/tax providers.");
  } finally {
    if (server.exitCode === null) {
      server.kill("SIGTERM");
      await Promise.race([
        new Promise<void>((resolve) => server.once("exit", () => resolve())),
        delay(5_000).then(() => {
          if (server.exitCode === null) server.kill("SIGKILL");
        }),
      ]);
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
