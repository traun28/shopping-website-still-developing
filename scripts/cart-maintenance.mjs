#!/usr/bin/env node
/**
 * Bounded Part 14 housekeeping. No email, marketing or checkout side-effects.
 *
 *   npm run cart:maintenance
 *   npm run cart:maintenance -- --limit 1000
 *
 * Marks inactive carts abandoned, expires carts past their configured TTL, and
 * removes expired cart/idempotency rows in bounded batches. Schedule it with a
 * single-instance cron until a shared job runner is configured.
 */
import "dotenv/config";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

// Service modules are server-only by design; this maintenance process is a
// trusted server-side entry point, so resolve the project's harmless test stub.
const require_ = createRequire(import.meta.url);
const Module = require_("node:module");
const serverOnlyStub = fileURLToPath(new URL("../tests/mocks/server-only.ts", import.meta.url));
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function patched(request, ...rest) {
  if (request === "server-only") return serverOnlyStub;
  return originalResolve.call(this, request, ...rest);
};

const { pool } = await import("../src/db/index.ts");
const cart = await import("../src/services/cart/cart.service.ts");
const rawLimit = process.argv.indexOf("--limit");
const limit = rawLimit >= 0 ? Number.parseInt(process.argv[rawLimit + 1] ?? "500", 10) : 500;
if (!Number.isInteger(limit) || limit < 1 || limit > 5000) {
  console.error("--limit must be an integer between 1 and 5000.");
  await pool.end();
  process.exit(1);
}

try {
  const now = new Date();
  const abandoned = await cart.markAbandonedCarts(now, limit);
  const expired = await cart.markExpiredCarts(now, limit);
  const deletedCarts = await cart.purgeExpiredCarts(now, limit);
  const deletedMutationKeys = await cart.purgeExpiredCartMutationKeys(now, Math.min(limit * 2, 10_000));
  console.log(JSON.stringify({ abandoned, expired, deletedCarts, deletedMutationKeys, ranAt: now.toISOString() }, null, 2));
} catch (error) {
  console.error(`Cart maintenance failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
