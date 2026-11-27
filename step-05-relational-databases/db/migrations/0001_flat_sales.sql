-- A year of sales exactly as a sales team might export it from a
-- spreadsheet: one row per order line, with the customer's and the
-- product's details repeated on every row that mentions them. This is
-- staging data, kept deliberately outside any company's tenant scope
-- (see NOTES.md) - it exists only to show the anomalies a flat design
-- causes before migration 0002 begins normalizing it away.
create schema if not exists staging;

create table staging.flat_sales (
  order_line_id bigint generated always as identity primary key,
  order_date date not null,
  customer_name text not null,
  customer_email text not null,
  customer_city text not null,
  product_name text not null,
  product_category text not null,
  product_price numeric(10, 2) not null,
  quantity integer not null
);

insert into staging.flat_sales
  (order_date, customer_name, customer_email, customer_city, product_name, product_category, product_price, quantity)
values
  -- Maria Lopez: her city is spelled two different ways across her own
  -- orders ("Austin" vs "Austin, TX") because nothing stops it - the
  -- update anomaly. Fixing her city means finding and editing every row
  -- that mentions her, and it's already out of sync here.
  ('2026-01-08', 'Maria Lopez', 'maria.lopez@example.com', 'Austin',      'Desk Lamp',     'Office',      24.99, 2),
  ('2026-02-14', 'Maria Lopez', 'maria.lopez@example.com', 'Austin',      'Notebook Pack', 'Stationery',   9.50, 3),
  ('2026-03-02', 'Maria Lopez', 'maria.lopez@example.com', 'Austin, TX',  'Standing Desk', 'Office',     449.00, 1),

  -- Noah Patel: this order line crams two different products into one
  -- cell, with a combined category and a price that no longer means
  -- "the price of one thing" - the 1NF violation (a repeating group, not
  -- one value per cell).
  ('2026-01-20', 'Noah Patel',  'noah.patel@example.com',  'Seattle',     'Desk Lamp, USB Cable', 'Office, Electronics', 32.49, 1),
  ('2026-04-11', 'Noah Patel',  'noah.patel@example.com',  'Seattle',     'Notebook Pack', 'Stationery',   9.50, 5),

  -- Derek Chen: he appears in exactly one order line. Delete this row
  -- (say, because the order was cancelled) and every trace that Derek is
  -- a customer - his email, his city - disappears with it. There's no
  -- separate place his details live.
  ('2026-05-30', 'Derek Chen',  'derek.chen@example.com',  'Denver',      'USB Cable',     'Electronics', 12.00, 4),

  -- A plain, anomaly-free-looking run of orders, so the table reads like
  -- a real year of sales and not just three rigged examples.
  ('2026-01-05', 'Priya Nair',  'priya.nair@example.com',  'Chicago',     'Notebook Pack', 'Stationery',   9.50, 2),
  ('2026-02-02', 'Priya Nair',  'priya.nair@example.com',  'Chicago',     'Desk Lamp',     'Office',      24.99, 1),
  ('2026-03-18', 'Priya Nair',  'priya.nair@example.com',  'Chicago',     'USB Cable',     'Electronics', 12.00, 3),
  ('2026-06-09', 'Priya Nair',  'priya.nair@example.com',  'Chicago',     'Standing Desk', 'Office',     449.00, 1),
  ('2026-07-21', 'Priya Nair',  'priya.nair@example.com',  'Chicago',     'Notebook Pack', 'Stationery',   9.50, 4),
  ('2026-01-11', 'James Okafor','james.okafor@example.com','Atlanta',     'USB Cable',     'Electronics', 12.00, 2),
  ('2026-02-25', 'James Okafor','james.okafor@example.com','Atlanta',     'Desk Lamp',     'Office',      24.99, 3),
  ('2026-04-30', 'James Okafor','james.okafor@example.com','Atlanta',     'Notebook Pack', 'Stationery',   9.50, 1),
  ('2026-05-14', 'James Okafor','james.okafor@example.com','Atlanta',     'Standing Desk', 'Office',     449.00, 2),
  ('2026-08-02', 'James Okafor','james.okafor@example.com','Atlanta',     'USB Cable',     'Electronics', 12.00, 5),
  ('2026-02-19', 'Lena Fischer','lena.fischer@example.com','Portland',   'Notebook Pack', 'Stationery',   9.50, 2),
  ('2026-03-27', 'Lena Fischer','lena.fischer@example.com','Portland',   'Standing Desk', 'Office',     449.00, 1),
  ('2026-05-06', 'Lena Fischer','lena.fischer@example.com','Portland',   'Desk Lamp',     'Office',      24.99, 2),
  ('2026-06-23', 'Lena Fischer','lena.fischer@example.com','Portland',   'USB Cable',     'Electronics', 12.00, 1),
  ('2026-09-10', 'Lena Fischer','lena.fischer@example.com','Portland',   'Notebook Pack', 'Stationery',   9.50, 3),
  ('2026-03-09', 'Omar Siddiqui','omar.siddiqui@example.com','Dallas',   'Desk Lamp',     'Office',      24.99, 1),
  ('2026-04-22', 'Omar Siddiqui','omar.siddiqui@example.com','Dallas',   'USB Cable',     'Electronics', 12.00, 2),
  ('2026-07-03', 'Omar Siddiqui','omar.siddiqui@example.com','Dallas',   'Standing Desk', 'Office',     449.00, 1),
  ('2026-08-19', 'Omar Siddiqui','omar.siddiqui@example.com','Dallas',   'Notebook Pack', 'Stationery',   9.50, 2),
  ('2026-10-01', 'Omar Siddiqui','omar.siddiqui@example.com','Dallas',   'Desk Lamp',     'Office',      24.99, 4),
  ('2026-04-05', 'Priya Nair',  'priya.nair@example.com',  'Chicago',     'USB Cable',     'Electronics', 12.00, 1),
  ('2026-08-28', 'James Okafor','james.okafor@example.com','Atlanta',     'Desk Lamp',     'Office',      24.99, 1),
  ('2026-09-15', 'Lena Fischer','lena.fischer@example.com','Portland',   'Standing Desk', 'Office',     449.00, 1),
  ('2026-10-20', 'Omar Siddiqui','omar.siddiqui@example.com','Dallas',   'Notebook Pack', 'Stationery',   9.50, 3),
  ('2026-11-02', 'Priya Nair',  'priya.nair@example.com',  'Chicago',     'Desk Lamp',     'Office',      24.99, 2),
  ('2026-11-17', 'James Okafor','james.okafor@example.com','Atlanta',     'Standing Desk', 'Office',     449.00, 1),
  ('2026-12-04', 'Lena Fischer','lena.fischer@example.com','Portland',   'USB Cable',     'Electronics', 12.00, 2),
  ('2026-12-19', 'Omar Siddiqui','omar.siddiqui@example.com','Dallas',   'Standing Desk', 'Office',     449.00, 1),
  ('2026-07-14', 'Priya Nair',  'priya.nair@example.com',  'Chicago',     'Notebook Pack', 'Stationery',   9.50, 1),
  ('2026-06-01', 'James Okafor','james.okafor@example.com','Atlanta',     'Notebook Pack', 'Stationery',   9.50, 2);
