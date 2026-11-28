-- 1NF: every cell holds exactly one value, with no repeating groups.
-- Noah Patel's first order breaks this - 'Desk Lamp, USB Cable' crams two
-- products into one cell, and 32.49 stops meaning "the price of one
-- thing" once the cell names two things. Split it into one row per
-- product, each with its own real price, and the rest of the table
-- already has one value per cell, so nothing else needs to change here.
delete from staging.flat_sales
where customer_name = 'Noah Patel'
  and product_name = 'Desk Lamp, USB Cable';

insert into staging.flat_sales
  (order_date, customer_name, customer_email, customer_city, product_name, product_category, product_price, quantity)
values
  ('2026-01-20', 'Noah Patel', 'noah.patel@example.com', 'Seattle', 'Desk Lamp', 'Office',      24.99, 1),
  ('2026-01-20', 'Noah Patel', 'noah.patel@example.com', 'Seattle', 'USB Cable', 'Electronics', 12.00, 1);
