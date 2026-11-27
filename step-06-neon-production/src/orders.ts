import type { Client } from "pg";
import { answerBusinessQuestion, type BusinessQuestion } from "./sales";

export interface OrderListFilters {
  orgId: string;
  fromDate?: string;
  toDate?: string;
  customerName?: string;
  productName?: string;
  cursor?: string;
  limit: number;
}

export interface OrderListRow {
  orderId: string;
  orderDate: string;
  customerName: string;
  itemCount: number;
  orderTotal: string;
}

export interface OrderListResult {
  orders: OrderListRow[];
  nextCursor: string | null;
}

// A cursor is just the last order_id already returned, opaque to the
// caller (base64, not a raw id) so nothing outside this file needs to
// know or rely on that encoding. Keyset pagination on order_id (not
// OFFSET) keeps every page a real, stable slice: an OFFSET page shifts
// under you if a row is inserted while you're still paging through.
function encodeCursor(orderId: string): string {
  return Buffer.from(orderId, "utf8").toString("base64");
}

function decodeCursor(cursor: string): string {
  return Buffer.from(cursor, "base64").toString("utf8");
}

export async function listOrders(client: Client, filters: OrderListFilters): Promise<OrderListResult> {
  const afterOrderId = filters.cursor ? decodeCursor(filters.cursor) : null;

  // Fetch one extra row to find out whether a next page exists, without
  // a separate count query. The product filter is an EXISTS, not a join,
  // so it doesn't multiply or drop rows that would otherwise appear once
  // per matching line.
  const result = await client.query<{
    order_id: string;
    order_date: string;
    customer_name: string;
    item_count: string;
    order_total: string;
  }>(
    `select
       o.order_id,
       to_char(o.order_date, 'YYYY-MM-DD') as order_date,
       c.name as customer_name,
       count(oi.line_no) as item_count,
       sum(oi.quantity * oi.unit_price) as order_total
     from orders o
     join customers c on c.org_id = o.org_id and c.customer_id = o.customer_id
     join order_items oi on oi.org_id = o.org_id and oi.order_id = o.order_id
     where o.org_id = $1
       and ($2::date is null or o.order_date >= $2)
       and ($3::date is null or o.order_date <= $3)
       and ($4::text is null or c.name ilike '%' || $4 || '%')
       and ($5::bigint is null or o.order_id > $5)
       and (
         $6::text is null or exists (
           select 1
           from order_items oi2
           join products p2 on p2.org_id = oi2.org_id and p2.product_id = oi2.product_id
           where oi2.org_id = o.org_id and oi2.order_id = o.order_id and p2.name ilike '%' || $6 || '%'
         )
       )
     group by o.order_id, o.order_date, c.name
     order by o.order_id
     limit $7`,
    [
      filters.orgId,
      filters.fromDate ?? null,
      filters.toDate ?? null,
      filters.customerName ?? null,
      afterOrderId,
      filters.productName ?? null,
      filters.limit + 1,
    ],
  );

  const hasMore = result.rows.length > filters.limit;
  const page = hasMore ? result.rows.slice(0, filters.limit) : result.rows;

  return {
    orders: page.map((row) => ({
      orderId: row.order_id,
      orderDate: row.order_date,
      customerName: row.customer_name,
      itemCount: Number(row.item_count),
      orderTotal: row.order_total,
    })),
    nextCursor: hasMore ? encodeCursor(page[page.length - 1]!.order_id) : null,
  };
}

export const SUMMARY_GROUP_BY = ["month", "product", "customer"] as const;
export type SummaryGroupBy = (typeof SUMMARY_GROUP_BY)[number];

// Reuses answer_business_question's own fixed queries rather than
// duplicating them - monthly_revenue, top_products and best_customers
// are exactly "totals by month, product or customer", just addressed
// through a tool named for what a sales report actually asks for.
const GROUP_BY_TO_QUESTION: Record<SummaryGroupBy, BusinessQuestion> = {
  month: "monthly_revenue",
  product: "top_products",
  customer: "best_customers",
};

export async function getSalesSummary(client: Client, groupBy: SummaryGroupBy, orgId: string) {
  return answerBusinessQuestion(client, GROUP_BY_TO_QUESTION[groupBy], orgId);
}

export interface NewOrderItem {
  productName: string;
  quantity: number;
}

export interface NewOrderInput {
  orgId: string;
  customerName: string;
  orderDate: string;
  items: NewOrderItem[];
}

export interface CreatedOrderLine {
  productName: string;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
}

export interface CreatedOrder {
  orderId: string;
  orderDate: string;
  customerName: string;
  items: CreatedOrderLine[];
  orderTotal: string;
}

// A plain, named error (not thrown as a bare string or a generic Error)
// so index.ts can tell "the input didn't match anything real" apart
// from an actual server/database failure, and return the first as a
// clear, recoverable tool error instead of a crash.
export class OrderValidationError extends Error {}

// Runs the whole order as one transaction: either every row is inserted
// - the order header and every line - or none are. A customer typo or
// an unknown product must never leave a half-created order behind.
export async function createOrder(client: Client, input: NewOrderInput): Promise<CreatedOrder> {
  await client.query("begin");
  try {
    const customerResult = await client.query<{ customer_id: string }>(
      "select customer_id from customers where org_id = $1 and name = $2",
      [input.orgId, input.customerName],
    );
    if (customerResult.rows.length === 0) {
      throw new OrderValidationError(
        `No customer named "${input.customerName}" found in your company. Check list_orders or ` +
          "get_sales_summary (groupBy customer) for existing customer names.",
      );
    }
    const customerId = customerResult.rows[0]!.customer_id;

    const orderResult = await client.query<{ order_id: string }>(
      "insert into orders (org_id, customer_id, order_date) values ($1, $2, $3) returning order_id",
      [input.orgId, customerId, input.orderDate],
    );
    const orderId = orderResult.rows[0]!.order_id;

    const lines: CreatedOrderLine[] = [];
    let lineNo = 1;
    for (const item of input.items) {
      const productResult = await client.query<{ product_id: string; price: string }>(
        "select product_id, price from products where org_id = $1 and name = $2",
        [input.orgId, item.productName],
      );
      if (productResult.rows.length === 0) {
        throw new OrderValidationError(
          `No product named "${item.productName}" found in your company's catalog. Check ` +
            "describe_schema or get_sales_summary (groupBy product) for existing product names.",
        );
      }
      const { product_id: productId, price } = productResult.rows[0]!;

      // Copies the catalog price at the moment of sale, same deliberate
      // break from 3NF that step 5's migration made: a later catalog
      // price change must never rewrite what this order already charged.
      await client.query(
        "insert into order_items (org_id, order_id, line_no, product_id, quantity, unit_price) values ($1, $2, $3, $4, $5, $6)",
        [input.orgId, orderId, lineNo, productId, item.quantity, price],
      );
      lines.push({
        productName: item.productName,
        quantity: item.quantity,
        unitPrice: price,
        lineTotal: (Number(price) * item.quantity).toFixed(2),
      });
      lineNo += 1;
    }

    await client.query("commit");

    return {
      orderId,
      orderDate: input.orderDate,
      customerName: input.customerName,
      items: lines,
      orderTotal: lines.reduce((sum, line) => sum + Number(line.lineTotal), 0).toFixed(2),
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}
