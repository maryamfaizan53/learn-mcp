import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { forTenant } from "../src/db";
import { createOrder } from "../src/orders";

// Two throwaway companies, never used by any real account, that this
// file alone creates and cleans up. Acting as each one is exactly
// forTenant() - the same function every real tool call goes through -
// so this test exercises the real tenant boundary, not a mock of it.
const COMPANY_A = "rls-test-company-a";
const COMPANY_B = "rls-test-company-b";

async function seedCompany(orgId: string, suffix: string) {
  await forTenant(orgId, async (client) => {
    await client.query("insert into categories (org_id, name) values ($1, $2)", [orgId, `Category ${suffix}`]);
    await client.query("insert into customers (org_id, name, email, city) values ($1, $2, $3, $4)", [
      orgId,
      `Customer ${suffix}`,
      `customer-${suffix}@example.com`,
      `City ${suffix}`,
    ]);
    const category = await client.query<{ category_id: string }>(
      "select category_id from categories where org_id = $1 and name = $2",
      [orgId, `Category ${suffix}`],
    );
    await client.query("insert into products (org_id, category_id, name, price) values ($1, $2, $3, $4)", [
      orgId,
      category.rows[0]!.category_id,
      `Product ${suffix}`,
      10.0,
    ]);
  });
  // A real order, through the actual tool code - not a hand-rolled
  // insert - so this test also proves createOrder() itself respects
  // the tenant it's given.
  await forTenant(orgId, (client) =>
    createOrder(client, {
      orgId,
      customerName: `Customer ${suffix}`,
      orderDate: "2026-01-01",
      items: [{ productName: `Product ${suffix}`, quantity: 1 }],
    }),
  );
}

async function cleanupCompany(orgId: string) {
  await forTenant(orgId, async (client) => {
    await client.query("delete from order_items where org_id = $1", [orgId]);
    await client.query("delete from orders where org_id = $1", [orgId]);
    await client.query("delete from products where org_id = $1", [orgId]);
    await client.query("delete from customers where org_id = $1", [orgId]);
    await client.query("delete from categories where org_id = $1", [orgId]);
  });
}

beforeAll(async () => {
  await seedCompany(COMPANY_A, "A");
  await seedCompany(COMPANY_B, "B");
});

afterAll(async () => {
  await cleanupCompany(COMPANY_A);
  await cleanupCompany(COMPANY_B);
});

// Acting as company A, every one of these queries has no org_id filter
// of its own - the point is to prove row-level security itself is what
// keeps company B's rows out, not application code remembering a WHERE
// clause (a tool that forgot one would still be safe; see NOTES.md for
// what was actually confirmed by deliberately breaking a policy).
describe("row-level security: acting as company A sees only company A", () => {
  it("categories", async () => {
    const rows = await forTenant(COMPANY_A, (client) => client.query("select name from categories"));
    expect(rows.rows.map((r) => r.name)).toEqual(["Category A"]);
  });

  it("customers", async () => {
    const rows = await forTenant(COMPANY_A, (client) => client.query("select name from customers"));
    expect(rows.rows.map((r) => r.name)).toEqual(["Customer A"]);
  });

  it("products", async () => {
    const rows = await forTenant(COMPANY_A, (client) => client.query("select name from products"));
    expect(rows.rows.map((r) => r.name)).toEqual(["Product A"]);
  });

  it("orders and order_items", async () => {
    const orders = await forTenant(COMPANY_A, (client) => client.query("select order_id from orders"));
    expect(orders.rows).toHaveLength(1);
    const items = await forTenant(COMPANY_A, (client) => client.query("select quantity from order_items"));
    expect(items.rows).toHaveLength(1);
  });

  it("an explicit attempt to read company B's org_id directly is still blocked", async () => {
    const rows = await forTenant(COMPANY_A, (client) =>
      client.query("select name from customers where org_id = $1", [COMPANY_B]),
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("createOrder for company A can't be tricked into naming company B's customer", async () => {
    await expect(
      forTenant(COMPANY_A, (client) =>
        createOrder(client, {
          orgId: COMPANY_A,
          customerName: "Customer B",
          orderDate: "2026-01-02",
          items: [{ productName: "Product A", quantity: 1 }],
        }),
      ),
    ).rejects.toThrow(/No customer named "Customer B"/);
  });
});
