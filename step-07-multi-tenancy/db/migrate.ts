// Applies every numbered file in db/migrations/, in filename order, that
// hasn't already run against this database - once each, never twice.
// Run from your own machine with `npm run migrate`, never from the Worker:
// migrations are a one-time admin action, not something a deployed Worker
// does on every request. Always run as the owner role (DATABASE_URL) -
// the connector role the Worker uses (via Hyperdrive) can't change the
// schema on purpose.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";

// Node's built-in .env-file loader reads .dev.vars's KEY=VALUE lines
// (dotenv-compatible format) straight into process.env. Optional: CI or a
// production migration run might already have DATABASE_URL set directly.
if (existsSync(".dev.vars")) {
  process.loadEnvFile(".dev.vars");
}

// Every tenant database gets the exact same migrations, in the exact same
// order - the shared one (DATABASE_URL), and one more per dedicated-tier
// company (TENANT_DATABASE_URLS, comma-separated: the shared database's
// own URL again, plus each dedicated company's own). No tool code ever
// knows which database it's talking to, and migrations don't either - a
// dedicated company's database just happens to end up with exactly one
// company's rows in otherwise identical tables.
const databaseUrls = process.env.TENANT_DATABASE_URLS
  ? process.env.TENANT_DATABASE_URLS.split(",").map((url) => url.trim()).filter(Boolean)
  : process.env.DATABASE_URL
    ? [process.env.DATABASE_URL]
    : [];
if (databaseUrls.length === 0) {
  console.error(
    "Neither DATABASE_URL nor TENANT_DATABASE_URLS is set. Add one to .dev.vars, or export it before " +
      "running `npm run migrate`.",
  );
  process.exit(1);
}

// Splitting a migration file into individual statements on top-level `;`
// is a simplification: it would still break on a dollar-quoted function
// body or a string literal containing a semicolon. None of this course's
// migrations need either, so it's not worth a real SQL parser here - but
// it's the reason to keep migrations to plain DDL and simple DML. Line
// comments are stripped first, though, since a semicolon inside one
// (explaining *why* a statement does something) is fair game and
// shouldn't fracture the statement after it.
function splitStatements(sqlText: string): string[] {
  const withoutLineComments = sqlText
    .split("\n")
    .map((line) => {
      const commentStart = line.indexOf("--");
      return commentStart === -1 ? line : line.slice(0, commentStart);
    })
    .join("\n");

  return withoutLineComments
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

async function migrateOne(databaseUrl: string): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`
      create table if not exists schema_migrations (
        filename text primary key,
        applied_at timestamptz not null default now()
      )
    `);

    const migrationsDir = join(import.meta.dirname, "migrations");
    const files = readdirSync(migrationsDir)
      .filter((name) => name.endsWith(".sql"))
      .sort();

    const applied = await client.query<{ filename: string }>("select filename from schema_migrations");
    const alreadyApplied = new Set(applied.rows.map((row) => row.filename));

    for (const file of files) {
      if (alreadyApplied.has(file)) {
        console.log(`skip  ${file} (already applied)`);
        continue;
      }

      const text = readFileSync(join(migrationsDir, file), "utf8");
      const statements = splitStatements(text);

      console.log(`apply ${file} (${statements.length} statement${statements.length === 1 ? "" : "s"})`);
      await client.query("begin");
      try {
        for (const statement of statements) {
          await client.query(statement);
        }
        await client.query("insert into schema_migrations (filename) values ($1)", [file]);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    }

  } finally {
    await client.end();
  }
}

async function main() {
  for (const [index, databaseUrl] of databaseUrls.entries()) {
    console.log(`--- database ${index + 1}/${databaseUrls.length} ---`);
    await migrateOne(databaseUrl);
  }
  console.log("Done.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
