// Applies every numbered file in db/migrations/, in filename order, that
// hasn't already run against this database - once each, never twice.
// Run from your own machine with `npm run migrate`, never from the Worker:
// migrations are a one-time admin action, not something a deployed Worker
// does on every request.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { neon } from "@neondatabase/serverless";

// Node's built-in .env-file loader reads .dev.vars's KEY=VALUE lines
// (dotenv-compatible format) straight into process.env. Optional: CI or a
// production migration run might already have DATABASE_URL set directly.
if (existsSync(".dev.vars")) {
  process.loadEnvFile(".dev.vars");
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error(
    "DATABASE_URL is not set. Add it to .dev.vars, or export it before running `npm run migrate`.",
  );
  process.exit(1);
}

const sql = neon(databaseUrl);

// Splitting a migration file into individual statements on top-level `;`
// is a simplification: it would break on a dollar-quoted function body or
// a string literal containing a semicolon. None of this course's
// migrations need either, so it's not worth a real SQL parser here - but
// it's the reason to keep migrations to plain DDL and simple DML.
function splitStatements(sqlText: string): string[] {
  return sqlText
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

async function main() {
  await sql`
    create table if not exists schema_migrations (
      filename text primary key,
      applied_at timestamptz not null default now()
    )
  `;

  const migrationsDir = join(import.meta.dirname, "migrations");
  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  const applied = await sql`select filename from schema_migrations`;
  const alreadyApplied = new Set(applied.map((row) => (row as { filename: string }).filename));

  for (const file of files) {
    if (alreadyApplied.has(file)) {
      console.log(`skip  ${file} (already applied)`);
      continue;
    }

    const text = readFileSync(join(migrationsDir, file), "utf8");
    const statements = splitStatements(text);

    console.log(`apply ${file} (${statements.length} statement${statements.length === 1 ? "" : "s"})`);
    await sql.transaction([
      ...statements.map((statement) => sql.query(statement)),
      sql`insert into schema_migrations (filename) values (${file})`,
    ]);
  }

  console.log("Done.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
