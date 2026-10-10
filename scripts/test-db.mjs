/**
 * Disposable PostgreSQL for the integration suite.
 *
 * Boots a real PostgreSQL cluster (embedded-postgres), creates a scratch
 * database, applies the Drizzle schema and every committed migration, runs the
 * test command with TEST_DATABASE_URL set, then destroys the cluster. Nothing
 * survives the run, so it is safe to run repeatedly and in CI.
 *
 *   npm run test:db                       # vitest over tests/integration
 *   npm run test:db -- tests/unit/foo.ts  # any vitest target
 *   node scripts/test-db.mjs -- npx vitest run            # full suite
 *   node scripts/test-db.mjs -- node scripts/verify-db.ts # any command
 *
 * Applying the schema with `drizzle-kit push` and then re-running every
 * migration is itself a check: the migrations are documented as idempotent, so
 * they must be no-ops over an already-pushed schema.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PORT = Number(process.env.TEST_DB_PORT ?? 55432);
const DB_NAME = process.env.TEST_DB_NAME ?? "inkline_test";
const USER = "postgres";
const PASSWORD = "postgres";

const MIGRATIONS = [
  "0003_catalog_management.sql",
  "0004_catalog_browsing.sql",
  "0005_product_details.sql",
  "0006_product_intelligence.sql",
  "0007_search_discovery.sql",
  "0008_recommendation_engine.sql",
  "0009_cart_wishlist_saved_items.sql",
  "0010_customer_checkout_preparation.sql",
  "0011_promotion_domain.sql",
];

function log(message) {
  process.stderr.write(`[test-db] ${message}\n`);
}

export async function startTestDatabase() {
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  const dataDir = mkdtempSync(join(tmpdir(), "inkline-pg-"));
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: USER,
    password: PASSWORD,
    port: PORT,
    persistent: true,
    onLog: () => {},
    onError: (message) => process.stderr.write(`[pg] ${message}\n`),
  });

  await pg.initialise();
  await pg.start();
  await pg.createDatabase(DB_NAME);
  const url = `postgresql://${USER}:${PASSWORD}@127.0.0.1:${PORT}/${DB_NAME}`;
  log(`cluster up on port ${PORT}`);

  // `drizzle-kit push` cannot introspect this PostgreSQL version, so the schema
  // is applied as generated DDL — which also validates that every Drizzle table
  // definition compiles to valid SQL.
  // Each invocation gets private Drizzle scratch paths so parallel DB jobs do
  // not remove each other's generated schema while they are being read.
  const scratchName = `${process.pid}-${randomUUID()}`;
  const outName = `.test-db-schema-${scratchName}`;
  const outDir = join(ROOT, outName);
  const configPath = join(ROOT, `.test-db-drizzle-${scratchName}.json`);
  rmSync(outDir, { recursive: true, force: true });
  writeFileSync(
    configPath,
    JSON.stringify({ dialect: "postgresql", schema: "./src/db/schema/index.ts", out: `./${outName}` }),
  );
  const gen = spawnSync("npx", ["drizzle-kit", "generate", `--config=${configPath}`, "--name=testdb"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (gen.status !== 0) {
    process.stderr.write(`${gen.stdout ?? ""}${gen.stderr ?? ""}`);
    rmSync(outDir, { recursive: true, force: true });
    rmSync(configPath, { force: true });
    await teardown(pg, dataDir);
    throw new Error("drizzle-kit generate failed — the Drizzle schema does not compile to valid SQL");
  }
  let schemaSql;
  try {
    schemaSql = readdirSync(outDir)
      .filter((file) => file.endsWith(".sql"))
      .sort()
      .map((file) => readFileSync(join(outDir, file), "utf8"))
      .join("\n");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
    rmSync(configPath, { force: true });
  }

  const schemaClient = pg.getPgClient(DB_NAME);
  await schemaClient.connect();
  try {
    // The search indexes use gin_trgm_ops; the committed migration installs the
    // extension, but the generated DDL is applied before it, so create it here.
    await schemaClient.query("CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS unaccent;");
    await schemaClient.query(schemaSql);
  } catch (error) {
    await schemaClient.end();
    await teardown(pg, dataDir);
    throw new Error(`generated schema failed to apply: ${error.message}`);
  }
  await schemaClient.end();
  log("schema applied");

  for (const file of MIGRATIONS) {
    const sql = readFileSync(join(ROOT, "drizzle", file), "utf8");
    const client = pg.getPgClient(DB_NAME);
    await client.connect();
    try {
      await client.query(sql);
      log(`migration applied (idempotent over the pushed schema): ${file}`);
    } catch (error) {
      await client.end();
      await teardown(pg, dataDir);
      throw new Error(`migration ${file} failed: ${error.message}`);
    }
    await client.end();
  }

  return { pg, dataDir, url };
}

async function teardown(pg, dataDir) {
  try {
    await pg.stop();
  } catch {
    /* already down */
  }
  rmSync(dataDir, { recursive: true, force: true });
}

async function main() {
  const args = process.argv.slice(2);
  const separator = args.indexOf("--");
  const command =
    separator >= 0
      ? args.slice(separator + 1)
      : ["npx", "vitest", "run", "--reporter=dot", "tests/integration"];
  if (command.length === 0) {
    process.stderr.write("usage: node scripts/test-db.mjs -- <command>\n");
    process.exit(1);
  }

  const { pg, dataDir, url } = await startTestDatabase();
  const child = spawn(command[0], command.slice(1), {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, TEST_DATABASE_URL: url, DATABASE_URL: process.env.DATABASE_URL ?? url },
  });

  const code = await new Promise((done) => {
    child.on("close", done);
  });
  await teardown(pg, dataDir);
  log("cluster destroyed");
  process.exit(code ?? 1);
}

// Allow `import { startTestDatabase }` from other tooling without running main.
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  await main();
}
