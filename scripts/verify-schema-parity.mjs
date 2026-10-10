/**
 * Migration parity check.
 *
 * Proves the property that actually protects deploys:
 *
 *   (schema at HEAD) + drizzle/0006..0008  ==  schema in working tree
 *
 * It builds two disposable databases — one from the Drizzle tables as they
 * exist now, one from the pre-migration schema plus the committed migrations —
 * then diffs their columns, indexes, enums and constraints. Any drift means
 * the SQL migration and the TypeScript schema disagree.
 *
 *   npm run db:parity                # compares against HEAD
 *   npm run db:parity -- <git-ref>   # compares against another ref
 *
 * Only extensions and seed rows may differ: the migration installs
 * pg_trgm/unaccent and seeds the default size/colour attribute axes, neither of
 * which a Drizzle table definition can express.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import pg from "pg";

const ROOT = resolve(import.meta.dirname, "..");
const PORT = Number(process.env.PARITY_DB_PORT ?? 55440);
const USER = "postgres";
const PASSWORD = "postgres";
// Part 11–15 migrations, applied in order on top of the schema at HEAD.
const MIGRATIONS = [
  "0006_product_intelligence.sql",
  "0007_search_discovery.sql",
  "0008_recommendation_engine.sql",
  "0009_cart_wishlist_saved_items.sql",
  "0010_customer_checkout_preparation.sql",
  "0011_promotion_domain.sql",
].map((name) => join(ROOT, "drizzle", name));

/** Legitimately present only in the migration-driven database. */
const KNOWN_MIGRATION_ONLY = (fact) =>
  /^extension:/.test(fact) || fact === "row:attribute_definitions:size" || fact === "row:attribute_definitions:color";

function fail(message) {
  process.stderr.write(`\n✗ ${message}\n`);
  process.exit(1);
}

/** Extract the pre-migration schema files from git into a scratch folder. */
function materialiseRefSchema(ref) {
  const dir = join(ROOT, ".parity-base-schema");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const files = spawnSync("git", ["ls-tree", "-r", "--name-only", ref, "src/db/schema"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (files.status !== 0) fail(`git ls-tree ${ref} failed: ${files.stderr}`);
  for (const path of files.stdout.split("\n").filter(Boolean)) {
    const content = spawnSync("git", ["show", `${ref}:${path}`], { cwd: ROOT, encoding: "utf8" });
    if (content.status !== 0) fail(`git show ${ref}:${path} failed`);
    writeFileSync(join(ROOT, path.replace("src/db/schema", ".parity-base-schema")), content.stdout);
  }
  return dir;
}

function generateSql(schemaDir, outDir) {
  rmSync(outDir, { recursive: true, force: true });
  const config = join(ROOT, `.parity-config-${outDir.replace(/\W/g, "_")}.json`);
  writeFileSync(
    config,
    JSON.stringify({ dialect: "postgresql", schema: schemaDir, out: `./${outDir}` }, null, 2),
  );
  const gen = spawnSync("npx", ["drizzle-kit", "generate", `--config=${config}`, "--name=parity"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (gen.status !== 0) fail(`drizzle-kit generate failed for ${schemaDir}:\n${gen.stdout}${gen.stderr}`);
  const sql = readdirSync(join(ROOT, outDir))
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => readFileSync(join(ROOT, outDir, file), "utf8"))
    .join("\n");
  rmSync(config, { force: true });
  rmSync(join(ROOT, outDir), { recursive: true, force: true });
  return sql;
}

async function describeSchema(client) {
  const facts = new Set();

  const columns = await client.query(`
    SELECT table_name, column_name, data_type, is_nullable, coalesce(column_default, '') AS d
      FROM information_schema.columns WHERE table_schema = 'public'`);
  for (const row of columns.rows) {
    facts.add(`column:${row.table_name}.${row.column_name}|${row.data_type}|${row.is_nullable}|${row.d}`);
  }

  const indexes = await client.query(`
    SELECT indexdef FROM pg_indexes WHERE schemaname = 'public'`);
  for (const row of indexes.rows) {
    const def = row.indexdef.replace(/"/g, "").replace(/public\./g, "").replace(/\s+/g, " ").trim().toLowerCase();
    facts.add(`index:${def}`);
  }

  const constraints = await client.query(`
    SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
     WHERE connamespace = 'public'::regnamespace`);
  for (const row of constraints.rows) {
    facts.add(`constraint:${row.conname}|${row.def.replace(/"/g, "").replace(/\s+/g, " ").trim().toLowerCase()}`);
  }

  const enums = await client.query(`
    SELECT t.typname, string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS labels
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'public'
     GROUP BY t.typname`);
  for (const row of enums.rows) facts.add(`enum:${row.typname}|${row.labels}`);

  const extensions = await client.query("SELECT extname FROM pg_extension");
  for (const row of extensions.rows) facts.add(`extension:${row.extname}`);

  const axes = await client.query("SELECT code FROM attribute_definitions").catch(() => ({ rows: [] }));
  for (const row of axes.rows) facts.add(`row:attribute_definitions:${row.code}`);

  return facts;
}

async function main() {
  const ref = process.argv[2] ?? "HEAD";
  for (const migration of MIGRATIONS) {
    if (!readFileSync(migration, "utf8")) fail(`${basename(migration)} is empty`);
  }

  const baseDir = materialiseRefSchema(ref);
  process.stderr.write(`[parity] generated baseline DDL from ${ref}\n`);
  const baseSql = generateSql("./.parity-base-schema", ".parity-out-base");
  process.stderr.write(`[parity] generated current DDL from working tree\n`);
  const currentSql = generateSql("./src/db/schema/index.ts", ".parity-out-current");
  rmSync(baseDir, { recursive: true, force: true });

  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  const dataDir = mkdtempSync(join(tmpdir(), "inkline-parity-"));
  const server = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: USER,
    password: PASSWORD,
    port: PORT,
    persistent: true,
    onLog: () => {},
    onError: (message) => process.stderr.write(`[pg] ${message}\n`),
  });
  await server.initialise();
  await server.start();

  try {
    await server.createDatabase("current");
    await server.createDatabase("migrated");
    const url = (name) => `postgresql://${USER}:${PASSWORD}@127.0.0.1:${PORT}/${name}`;

    const current = new pg.Client({ connectionString: url("current") });
    const migrated = new pg.Client({ connectionString: url("migrated") });
    await current.connect();
    await migrated.connect();

    const run = async (client, sql, label) => {
      try {
        await client.query(sql);
      } catch (error) {
        fail(`${label}: ${error.message}`);
      }
    };

    const extensions = "CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS unaccent;";
    // Both databases need the extensions, not just `current`. Once the Part 11/12
    // schema files were committed, the baseline generated from ${ref} itself
    // declares GIN trigram indexes, so applying it without pg_trgm fails on
    // "operator class gin_trgm_ops does not exist".
    await run(current, extensions, "extensions (current)");
    await run(migrated, extensions, "extensions (migrated)");
    await run(current, currentSql, "current Drizzle schema");
    await run(migrated, baseSql, `${ref} baseline schema`);
    for (const migration of MIGRATIONS) {
      await run(migrated, readFileSync(migration, "utf8"), basename(migration));
    }

    const currentFacts = await describeSchema(current);
    const migratedFacts = await describeSchema(migrated);
    await current.end();
    await migrated.end();

    const onlyCurrent = [...currentFacts].filter((f) => !migratedFacts.has(f));
    const onlyMigrated = [...migratedFacts].filter((f) => !currentFacts.has(f) && !KNOWN_MIGRATION_ONLY(f));

    if (onlyCurrent.length > 0 || onlyMigrated.length > 0) {
      process.stderr.write(
        `\nDrift between ${MIGRATIONS.map((m) => basename(m)).join(" + ")} and src/db/schema:\n`,
      );
      for (const fact of onlyCurrent.sort()) process.stderr.write(`  missing from migration : ${fact}\n`);
      for (const fact of onlyMigrated.sort()) process.stderr.write(`  extra in migration     : ${fact}\n`);
      fail(`${onlyCurrent.length + onlyMigrated.length} difference(s)`);
    }

    process.stdout.write(
      `✓ ${ref} + ${MIGRATIONS.map((m) => basename(m)).join(" + ")} == current Drizzle schema (${currentFacts.size} facts)\n`,
    );
  } finally {
    try {
      await server.stop();
    } catch {
      /* already down */
    }
    rmSync(dataDir, { recursive: true, force: true });
  }
}

await main();
