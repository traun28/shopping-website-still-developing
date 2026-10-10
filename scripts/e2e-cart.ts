import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";

const root = process.cwd();
const port = Number(process.env.CART_E2E_PORT ?? 3188);
const baseUrl = `http://127.0.0.1:${port}`;
const authSecret = process.env.AUTH_SECRET ?? "cart-e2e-only-secret-not-for-production";
let output = "";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function rememberOutput(chunk: Buffer | string) {
  output = `${output}${chunk.toString()}`.slice(-12_000);
}

async function findPurchasableVariant() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required; run via npm run e2e:cart.");
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const result = await client.query<{ product_id: string; variant_id: string }>(`
      SELECT p.id AS product_id, v.id AS variant_id
        FROM products p
        JOIN product_variants v ON v.product_id = p.id
       WHERE p.status = 'ACTIVE'
         AND v.is_active = true
         AND v.stock_quantity > v.reserved_quantity
       ORDER BY p.slug, v.sku
       LIMIT 1
    `);
    const row = result.rows[0];
    if (!row) throw new Error("No purchasable seeded product variant is available.");
    return row;
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

  const guestSession: { cookie: string | null } = { cookie: null };
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

    const product = { productId, variantId, quantity: 1, source: "PRODUCT_PAGE" };
    const request = async (path: string, method: string, body?: unknown, key?: string, origin = baseUrl) => {
      const headers = new Headers({ "Content-Type": "application/json", Origin: origin });
      if (guestSession.cookie) headers.set("Cookie", guestSession.cookie);
      if (key) headers.set("Idempotency-Key", key);
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        data?: Record<string, unknown>;
        error?: { code?: string; message?: string };
      };
      const setCookie = response.headers
        .getSetCookie()
        .find((value) => value.startsWith("inkline_cart_session=")) ?? null;
      if (setCookie) guestSession.cookie = setCookie.split(";")[0] ?? null;
      return { response, payload, setCookie };
    };

    const blocked = await request("/api/cart/items", "POST", product, "cart-e2e-csrf-0001", "https://attacker.invalid");
    assert(blocked.response.status === 403, `Cross-origin cart mutation was not rejected (HTTP ${blocked.response.status}).`);

    const firstAdd = await request("/api/cart/items", "POST", product, "cart-e2e-add-000001");
    assert(firstAdd.response.ok && firstAdd.payload.ok && firstAdd.payload.data, `Add failed: ${JSON.stringify(firstAdd.payload)}`);
    assert(!firstAdd.payload.data.replayed, "First add unexpectedly replayed an old mutation.");
    assert(firstAdd.setCookie?.includes("HttpOnly") && firstAdd.setCookie.includes("SameSite=Lax"), "Guest session cookie is missing required attributes.");
    assert(guestSession.cookie?.startsWith("inkline_cart_session="), "The guest session cookie was not retained for subsequent requests.");
    const itemId = String(firstAdd.payload.data.itemId);
    const serverUnitPrice = Number(firstAdd.payload.data.currentUnitPricePaise);
    assert(itemId && Number.isSafeInteger(serverUnitPrice) && serverUnitPrice > 0, "The server did not return a valid priced cart line.");

    const retry = await request("/api/cart/items", "POST", product, "cart-e2e-add-000001");
    assert(
      retry.response.ok && retry.payload.data?.replayed === true,
      `Retry did not replay its idempotent result (set-cookie returned: ${Boolean(retry.setCookie)}; body: ${JSON.stringify(retry.payload)}).`,
    );

    let snapshot = await request("/api/cart", "GET");
    assert(snapshot.response.ok && snapshot.payload.data, `Cart read failed: ${JSON.stringify(snapshot.payload)}`);
    let cart = snapshot.payload.data;
    assert(cart.itemCount === 1 && Array.isArray(cart.items), "The guest cart did not persist its added item.");
    assert(cart.totals && (cart.totals as Record<string, unknown>).subtotalPaise === serverUnitPrice, "Cart subtotal was not computed from the server quote.");

    const update = await request(`/api/cart/items/${itemId}`, "PATCH", { quantity: 2, cartVersion: cart.version }, "cart-e2e-update-0001");
    assert(update.response.ok && update.payload.ok, `Quantity update failed: ${JSON.stringify(update.payload)}`);
    snapshot = await request("/api/cart", "GET");
    assert(snapshot.payload.data, "Cart disappeared after quantity update.");
    cart = snapshot.payload.data;
    const cartLines = cart.items as Array<Record<string, unknown>>;
    assert(cartLines[0]?.quantity === 2, "The quantity update was not persisted.");
    assert((cart.totals as Record<string, unknown>).subtotalPaise === serverUnitPrice * 2, "Updated subtotal does not match the server-priced quantity.");

    const save = await request(
      `/api/cart/items/${itemId}/save-for-later`,
      "POST",
      { cartVersion: cart.version },
      "cart-e2e-save-later-01",
    );
    assert(save.response.ok && save.payload.data, `Save for Later failed: ${JSON.stringify(save.payload)}`);
    const savedItemId = String(save.payload.data.itemId);
    snapshot = await request("/api/cart", "GET");
    assert(snapshot.payload.data && (snapshot.payload.data.items as unknown[]).length === 0, "Save for Later left the line in the active cart.");
    const saved = await request("/api/cart/saved-items", "GET");
    assert(saved.response.ok && saved.payload.data, `Saved-items read failed: ${JSON.stringify(saved.payload)}`);
    assert((saved.payload.data.items as unknown[]).length === 1, "Save for Later was not kept in its distinct collection.");

    const restore = await request(
      `/api/cart/saved-items/${savedItemId}/restore`,
      "POST",
      { cartVersion: (snapshot.payload.data as Record<string, unknown>).version },
      "cart-e2e-restore-0001",
    );
    assert(restore.response.ok && restore.payload.ok, `Restore failed: ${JSON.stringify(restore.payload)}`);
    snapshot = await request("/api/cart", "GET");
    assert(snapshot.payload.data && (snapshot.payload.data.items as Array<Record<string, unknown>>)[0]?.quantity === 2, "Restored cart line lost its quantity.");

    const restoredCart = snapshot.payload.data;
    const line = (restoredCart.items as Array<Record<string, unknown>>)[0]!;
    const remove = await request(`/api/cart/items/${line.id}`, "DELETE", { cartVersion: restoredCart.version }, "cart-e2e-remove-0001");
    assert(remove.response.ok && remove.payload.ok, `Remove failed: ${JSON.stringify(remove.payload)}`);
    snapshot = await request("/api/cart", "GET");
    assert(snapshot.payload.data && (snapshot.payload.data.items as unknown[]).length === 0, "Removed cart line is still present.");

    console.log("✓ HTTP cart flow: same-origin protection, guest cookie, add/retry, live totals, quantity update, Save for Later, restore and remove.");
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
