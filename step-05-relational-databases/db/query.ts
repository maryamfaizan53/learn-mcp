// A tiny ad-hoc SQL runner for your own terminal, so you don't need a
// separate Postgres client (psql, a GUI, ...) just to run a one-off SELECT
// against your Neon branch. Reuses the same driver and .dev.vars as
// migrate.ts. Never imported by the Worker - this is a local dev tool only.
//
// Usage: npm run query "select * from staging.flat_sales limit 5"
import { existsSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

if (existsSync(".dev.vars")) {
  process.loadEnvFile(".dev.vars");
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set. Add it to .dev.vars first.");
  process.exit(1);
}

const statement = process.argv.slice(2).join(" ");
if (!statement.trim()) {
  console.error('Usage: npm run query "select ..."');
  process.exit(1);
}

const sql = neon(databaseUrl);

sql
  .query(statement)
  .then((rows) => {
    if (Array.isArray(rows) && rows.length > 0) {
      console.table(rows);
    } else {
      console.log("(0 rows)");
    }
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
