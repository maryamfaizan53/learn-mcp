import type { Client } from "pg";

// Every question here is a fixed, reviewed SQL statement with one
// parameter (the caller's org_id) - never SQL the model writes. Keeping
// this list in one place also makes it obvious, at a glance, exactly
// what a caller can ask this server to compute.
export const BUSINESS_QUESTIONS = [
  "monthly_revenue",
  "top_products",
  "best_customers",
  "revenue_by_category",
  "average_order_value",
  "orders_per_customer",
  "top_products_by_quantity",
  "revenue_by_city",
  "largest_single_order",
  "monthly_order_count",
] as const;

export type BusinessQuestion = (typeof BUSINESS_QUESTIONS)[number];

const QUESTION_SQL: Record<BusinessQuestion, string> = {
  monthly_revenue: `
    select to_char(o.order_date, 'YYYY-MM') as month, sum(oi.quantity * oi.unit_price) as revenue
    from orders o
    join order_items oi on oi.org_id = o.org_id and oi.order_id = o.order_id
    where o.org_id = $1
    group by month
    order by month
  `,
  top_products: `
    select p.name, sum(oi.quantity * oi.unit_price) as revenue
    from order_items oi
    join products p on p.org_id = oi.org_id and p.product_id = oi.product_id
    where oi.org_id = $1
    group by p.name
    order by revenue desc
    limit 10
  `,
  best_customers: `
    select c.name, sum(oi.quantity * oi.unit_price) as revenue
    from order_items oi
    join orders o on o.org_id = oi.org_id and o.order_id = oi.order_id
    join customers c on c.org_id = o.org_id and c.customer_id = o.customer_id
    where oi.org_id = $1
    group by c.name
    order by revenue desc
    limit 10
  `,
  revenue_by_category: `
    select cat.name as category, sum(oi.quantity * oi.unit_price) as revenue
    from order_items oi
    join products p on p.org_id = oi.org_id and p.product_id = oi.product_id
    join categories cat on cat.org_id = p.org_id and cat.category_id = p.category_id
    where oi.org_id = $1
    group by cat.name
    order by revenue desc
  `,
  average_order_value: `
    select avg(order_total) as average_order_value
    from (
      select o.order_id, sum(oi.quantity * oi.unit_price) as order_total
      from orders o
      join order_items oi on oi.org_id = o.org_id and oi.order_id = o.order_id
      where o.org_id = $1
      group by o.order_id
    ) per_order
  `,
  orders_per_customer: `
    select c.name, count(distinct o.order_id) as order_count
    from customers c
    join orders o on o.org_id = c.org_id and o.customer_id = c.customer_id
    where c.org_id = $1
    group by c.name
    order by order_count desc
  `,
  top_products_by_quantity: `
    select p.name, sum(oi.quantity) as total_quantity
    from order_items oi
    join products p on p.org_id = oi.org_id and p.product_id = oi.product_id
    where oi.org_id = $1
    group by p.name
    order by total_quantity desc
    limit 10
  `,
  revenue_by_city: `
    select c.city, sum(oi.quantity * oi.unit_price) as revenue
    from order_items oi
    join orders o on o.org_id = oi.org_id and o.order_id = oi.order_id
    join customers c on c.org_id = o.org_id and c.customer_id = o.customer_id
    where oi.org_id = $1
    group by c.city
    order by revenue desc
  `,
  largest_single_order: `
    select o.order_id, o.order_date, c.name as customer, sum(oi.quantity * oi.unit_price) as order_total
    from orders o
    join customers c on c.org_id = o.org_id and c.customer_id = o.customer_id
    join order_items oi on oi.org_id = o.org_id and oi.order_id = o.order_id
    where o.org_id = $1
    group by o.order_id, o.order_date, c.name
    order by order_total desc
    limit 1
  `,
  monthly_order_count: `
    select to_char(order_date, 'YYYY-MM') as month, count(*) as order_count
    from orders
    where org_id = $1
    group by month
    order by month
  `,
};

// pg's QueryResultRow constraint just requires an object type, which
// every row shape here already satisfies - the cast is for params only
// (pg's types want a concrete tuple, not our generic unknown[]).
async function queryRows<T extends Record<string, unknown>>(
  client: Client,
  text: string,
  params?: unknown[],
): Promise<T[]> {
  const result = await client.query<T>(text, params as any[] | undefined);
  return result.rows;
}

export async function answerBusinessQuestion(client: Client, question: BusinessQuestion, orgId: string) {
  return queryRows<Record<string, unknown>>(client, QUESTION_SQL[question], [orgId]);
}

// Only the questions with a clean, direct equivalent on the ungoverned
// flat table - one that needs no join, since staging.flat_sales never
// had customers/products/orders tables to join against in the first
// place. Always compares against the fixed demo company, not the
// caller's own company: staging.flat_sales only ever held the demo
// data, so comparing it against any other company's normalized rows
// wouldn't be a comparison of the same data at all.
export const COMPARE_QUESTIONS = [
  "monthly_revenue",
  "top_products",
  "best_customers",
  "revenue_by_city",
] as const;

export type CompareQuestion = (typeof COMPARE_QUESTIONS)[number];

export const DEMO_ORG_ID = "demo-company";

const FLAT_SQL: Record<CompareQuestion, string> = {
  monthly_revenue: `
    select to_char(order_date, 'YYYY-MM') as month, sum(quantity * product_price) as revenue
    from staging.flat_sales
    group by month
    order by month
  `,
  top_products: `
    select product_name as name, sum(quantity * product_price) as revenue
    from staging.flat_sales
    group by product_name
    order by revenue desc
    limit 10
  `,
  best_customers: `
    select customer_name as name, sum(quantity * product_price) as revenue
    from staging.flat_sales
    group by customer_name
    order by revenue desc
    limit 10
  `,
  revenue_by_city: `
    select customer_city as city, sum(quantity * product_price) as revenue
    from staging.flat_sales
    group by customer_city
    order by revenue desc
  `,
};

// Each note names a real anomaly in THIS course's demo data, not a
// generic warning - written once, by a human who already knows what the
// data contains, rather than computed by diffing two result sets (which
// risks being misleadingly "smart" about numbers that happen to match).
const COMPARE_NOTES: Record<CompareQuestion, string> = {
  monthly_revenue:
    "The flat design's total still includes Noah Patel's original order at its original (correct) price, " +
    "so monthly totals should actually agree here - this question mainly shows the normalized design can " +
    "answer it with a shorter query, not that the numbers differ.",
  top_products:
    "Before migration 0002, this would have undercounted Desk Lamp and USB Cable revenue, because one " +
    "combined row ('Desk Lamp, USB Cable') had no real per-product price to attribute. Once 1NF is fixed, " +
    "this list agrees with the normalized one.",
  best_customers:
    "Agrees here too, now that 1NF is fixed - but Derek Chen is one cancelled order away from vanishing " +
    "from this list entirely in the flat design, since his only record is that one order line.",
  revenue_by_city:
    "The flat design reports Maria Lopez's revenue under two different cities ('Austin' and 'Austin, TX'), " +
    "because her city is copied onto every order line instead of stored once. The normalized design reports " +
    "it under one city, because customers.city can only hold a single value per customer.",
};

export async function compareDesigns(client: Client, question: CompareQuestion) {
  // Sequential, not Promise.all: a single pg Client processes one query
  // at a time on one TCP connection anyway (node-postgres queues
  // concurrent calls internally), so awaiting each in turn is no slower
  // and reads more honestly.
  const flat = await queryRows<Record<string, unknown>>(client, FLAT_SQL[question]);
  const normalized = await queryRows<Record<string, unknown>>(client, QUESTION_SQL[question], [DEMO_ORG_ID]);
  return { flat, normalized, note: COMPARE_NOTES[question] };
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
}

export interface TableInfo {
  schema: string;
  name: string;
  columns: ColumnInfo[];
  primaryKey: string[];
}

// Reads the schema from Postgres's own catalog, rather than hardcoding
// the table list here, so this tool never drifts out of sync with the
// actual migrations. Every row describes structure (column names, types,
// keys), never data, so there's nothing here to scope by company.
export async function describeSchema(client: Client): Promise<TableInfo[]> {
  const tables = await queryRows<{ table_schema: string; table_name: string }>(
    client,
    `select table_schema, table_name
     from information_schema.tables
     where table_schema in ('public', 'staging') and table_type = 'BASE TABLE'
     order by table_schema, table_name`,
  );

  const result: TableInfo[] = [];
  for (const { table_schema, table_name } of tables) {
    const columns = await queryRows<{ column_name: string; data_type: string; is_nullable: string }>(
      client,
      `select column_name, data_type, is_nullable
       from information_schema.columns
       where table_schema = $1 and table_name = $2
       order by ordinal_position`,
      [table_schema, table_name],
    );
    const primaryKey = await queryRows<{ column_name: string }>(
      client,
      `select kcu.column_name
       from information_schema.table_constraints tc
       join information_schema.key_column_usage kcu
         on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
       where tc.table_schema = $1 and tc.table_name = $2 and tc.constraint_type = 'PRIMARY KEY'
       order by kcu.ordinal_position`,
      [table_schema, table_name],
    );
    result.push({
      schema: table_schema,
      name: table_name,
      columns: columns.map((c) => ({
        name: c.column_name,
        type: c.data_type,
        nullable: c.is_nullable === "YES",
      })),
      primaryKey: primaryKey.map((k) => k.column_name),
    });
  }
  return result;
}
