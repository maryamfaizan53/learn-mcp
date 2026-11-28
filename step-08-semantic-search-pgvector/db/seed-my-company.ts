// Copies the demo company's normalized sales data into your own
// signed-in company, so the server's tools have something real to show
// when you connect from Claude or ChatGPT. Run once, from your terminal:
//
//   npm run seed -- <your-org-id>
//
// Find <your-org-id> with:
//   npx wrangler d1 execute learn-mcp-step-04-auth --remote --command
//     "select user.email, member.organizationId from member join user on user.id = member.userId"
//
// Safe to re-run: it checks whether your company already has customers
// before copying anything, so running it twice is a no-op, not a
// duplicate-data mess.
import { existsSync } from "node:fs";
import { Client } from "pg";

if (existsSync(".dev.vars")) {
  process.loadEnvFile(".dev.vars");
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set. Add it to .dev.vars first.");
  process.exit(1);
}

const targetOrgId = process.argv[2];
if (!targetOrgId) {
  console.error("Usage: npm run seed -- <your-org-id>");
  process.exit(1);
}

const DEMO_ORG_ID = "demo-company";

async function main() {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const existing = await client.query("select 1 from customers where org_id = $1 limit 1", [targetOrgId]);
    if (existing.rows.length > 0) {
      console.log(`Company ${targetOrgId} already has data. Nothing to do.`);
      return;
    }

    // Each insert copies by name, not by the demo company's ids: the new
    // rows get their own fresh ids (from each table's own identity
    // sequence), and later inserts find the right new id the same way
    // migration 0003 built the demo data in the first place - by joining
    // back on the unique (org_id, name) pair, never by reusing an id that
    // belongs to a different company.
    await client.query("begin");
    try {
      await client.query(
        `insert into categories (org_id, name)
         select $1, name from categories where org_id = $2`,
        [targetOrgId, DEMO_ORG_ID],
      );
      await client.query(
        `insert into customers (org_id, name, email, city)
         select $1, name, email, city from customers where org_id = $2`,
        [targetOrgId, DEMO_ORG_ID],
      );
      await client.query(
        `insert into products (org_id, category_id, name, price)
         select $1, c.category_id, p.name, p.price
         from products p
         join categories c on c.org_id = $1 and c.name = (
           select name from categories where org_id = $2 and category_id = p.category_id
         )
         where p.org_id = $2`,
        [targetOrgId, DEMO_ORG_ID],
      );
      await client.query(
        `insert into orders (org_id, customer_id, order_date)
         select $1, cu.customer_id, o.order_date
         from orders o
         join customers cu on cu.org_id = $1 and cu.email = (
           select email from customers where org_id = $2 and customer_id = o.customer_id
         )
         where o.org_id = $2`,
        [targetOrgId, DEMO_ORG_ID],
      );
      await client.query(
        `insert into order_items (org_id, order_id, line_no, product_id, quantity, unit_price)
         select
           $1,
           new_o.order_id,
           oi.line_no,
           new_p.product_id,
           oi.quantity,
           oi.unit_price
         from order_items oi
         join orders demo_o on demo_o.org_id = $2 and demo_o.order_id = oi.order_id
         join customers demo_cu on demo_cu.org_id = $2 and demo_cu.customer_id = demo_o.customer_id
         join orders new_o on new_o.org_id = $1 and new_o.order_date = demo_o.order_date
           and new_o.customer_id = (select customer_id from customers where org_id = $1 and email = demo_cu.email)
         join products demo_p on demo_p.org_id = $2 and demo_p.product_id = oi.product_id
         join products new_p on new_p.org_id = $1 and new_p.name = demo_p.name
         where oi.org_id = $2`,
        [targetOrgId, DEMO_ORG_ID],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }

    console.log(`Seeded ${targetOrgId} from ${DEMO_ORG_ID}.`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
