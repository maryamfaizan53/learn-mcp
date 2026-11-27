-- 3NF: no column depends on another non-key column. flat_sales (after
-- 0002) has a single surrogate key, order_line_id, so 2NF already holds
-- automatically - there's no composite key for a column to be partially
-- dependent on. But customer_email/customer_city depend on customer_name
-- (a non-key column, not the key), and product_category/product_price
-- depend on product_name (same problem) - classic transitive
-- dependencies, and exactly what caused the update and delete anomalies.
--
-- Every table here is tenant-scoped: org_id is part of every primary key
-- and every foreign key, per book lesson 19.7 and this course's
-- multi-tenancy rules, so no row can ever point at another company's
-- row. Demo data is loaded under a fixed 'demo-company' org_id here;
-- copying it into your own signed-in company is the seed script that
-- follows this migration.

create table categories (
  org_id text not null,
  category_id bigint generated always as identity,
  name text not null,
  primary key (org_id, category_id),
  unique (org_id, name)
);

create table customers (
  org_id text not null,
  customer_id bigint generated always as identity,
  name text not null,
  email text not null,
  city text not null,
  primary key (org_id, customer_id),
  unique (org_id, email)
);

create table products (
  org_id text not null,
  product_id bigint generated always as identity,
  category_id bigint not null,
  name text not null,
  price numeric(10, 2) not null check (price >= 0),
  primary key (org_id, product_id),
  unique (org_id, name),
  foreign key (org_id, category_id) references categories (org_id, category_id)
);

create table orders (
  org_id text not null,
  order_id bigint generated always as identity,
  customer_id bigint not null,
  order_date date not null,
  primary key (org_id, order_id),
  foreign key (org_id, customer_id) references customers (org_id, customer_id)
);

-- unit_price is the copy kept on purpose: it's what the customer actually
-- paid on this line, which must never drift if products.price changes
-- later. Everything else here (quantity, which product, which order)
-- depends on the whole (org_id, order_id, line_no) key and nothing else.
create table order_items (
  org_id text not null,
  order_id bigint not null,
  line_no integer not null,
  product_id bigint not null,
  quantity integer not null check (quantity > 0),
  unit_price numeric(10, 2) not null check (unit_price >= 0),
  primary key (org_id, order_id, line_no),
  foreign key (org_id, order_id) references orders (org_id, order_id),
  foreign key (org_id, product_id) references products (org_id, product_id)
);

insert into categories (org_id, name)
select distinct 'demo-company', product_category
from staging.flat_sales;

-- Normalizing forces a decision the flat table let us avoid: which of
-- Maria Lopez's two recorded cities is actually correct? We resolve it
-- in favor of "Austin" (the spelling on 2 of her 3 orders) - picking one
-- answer, instead of silently keeping both, is the whole point of 3NF.
insert into customers (org_id, name, email, city)
select distinct on (customer_email)
  'demo-company',
  customer_name,
  customer_email,
  case when customer_email = 'maria.lopez@example.com' then 'Austin' else customer_city end
from staging.flat_sales
order by customer_email;

insert into products (org_id, category_id, name, price)
select distinct 'demo-company', c.category_id, f.product_name, f.product_price
from (select distinct product_name, product_category, product_price from staging.flat_sales) f
join categories c on c.org_id = 'demo-company' and c.name = f.product_category;

insert into orders (org_id, customer_id, order_date)
select distinct 'demo-company', cu.customer_id, f.order_date
from staging.flat_sales f
join customers cu on cu.org_id = 'demo-company' and cu.email = f.customer_email;

insert into order_items (org_id, order_id, line_no, product_id, quantity, unit_price)
select
  'demo-company',
  o.order_id,
  row_number() over (partition by o.order_id order by f.product_name),
  p.product_id,
  f.quantity,
  f.product_price
from staging.flat_sales f
join customers cu on cu.org_id = 'demo-company' and cu.email = f.customer_email
join orders o on o.org_id = 'demo-company' and o.customer_id = cu.customer_id and o.order_date = f.order_date
join products p on p.org_id = 'demo-company' and p.name = f.product_name;
