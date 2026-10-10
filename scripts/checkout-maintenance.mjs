#!/usr/bin/env node
/**
 * Bounded Part 15 housekeeping. Expires sessions, clears scheduled PII snapshots
 * and prunes old checkout idempotency metadata; session rows stay for reporting.
 * No payment, inventory, order, email or marketing side-effects.
 *
 *   npm run checkout:maintenance
 *   npm run checkout:maintenance -- --limit 1000
 *
 * Schedule as a single-instance cron until a shared job runner is configured.
 */
import "dotenv/config";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const require_ = createRequire(import.meta.url);
const Module = require_("node:module");
const serverOnlyStub = fileURLToPath(new URL("../tests/mocks/server-only.ts", import.meta.url));
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function patched(request, ...rest) {
  if (request === "server-only") return serverOnlyStub;
  return originalResolve.call(this, request, ...rest);
};

const { pool } = await import("../src/db/index.ts");
const checkout = await import("../src/services/checkout/checkout.service.ts");
const rawLimit = process.argv.indexOf("--limit");
const limit = rawLimit >= 0 ? Number.parseInt(process.argv[rawLimit + 1] ?? "500", 10) : 500;
if (!Number.isInteger(limit) || limit < 1 || limit > 5_000) {
  console.error("--limit must be an integer between 1 and 5000.");
  await pool.end();
  process.exit(1);
}

try {
  const now = new Date();
  const results = await checkout.runCheckoutMaintenance(now, limit);
  console.log(JSON.stringify({ ...results, ranAt: now.toISOString(), batchLimit: limit }, null, 2));
} catch (error) {
  console.error(`Checkout maintenance failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
