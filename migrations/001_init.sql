CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('student', 'canteen', 'rider', 'admin')),
  canteen_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((role = 'canteen' AND canteen_id IS NOT NULL) OR role <> 'canteen')
);

CREATE TABLE IF NOT EXISTS auth_challenges (
  email TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_challenges_expiry_idx ON auth_challenges(expires_at);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS menu_items (
  id SERIAL PRIMARY KEY,
  canteen_id TEXT NOT NULL CHECK (canteen_id IN ('MBA', 'IT', 'MC')),
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  price_paise INTEGER NOT NULL CHECK (price_paise > 0),
  is_veg BOOLEAN NOT NULL DEFAULT true,
  available BOOLEAN NOT NULL DEFAULT true,
  rating NUMERIC(2,1) NOT NULL DEFAULT 4.5,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS menu_items_outlet_idx ON menu_items(canteen_id, available);

CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES users(id),
  canteen_id TEXT NOT NULL,
  rider_id UUID REFERENCES users(id),
  gate TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PLACED'
    CHECK (status IN ('PLACED', 'ACCEPTED', 'PREPARING', 'READY', 'ASSIGNED', 'PICKED_UP', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED')),
  total_paise INTEGER NOT NULL CHECK (total_paise > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orders_student_idx ON orders(student_id, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_outlet_idx ON orders(canteen_id, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status, created_at);

CREATE TABLE IF NOT EXISTS order_items (
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id INTEGER NOT NULL REFERENCES menu_items(id),
  item_name TEXT NOT NULL,
  unit_price_paise INTEGER NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 20),
  PRIMARY KEY (order_id, menu_item_id)
);

CREATE TABLE IF NOT EXISTS demand_history (
  id BIGSERIAL PRIMARY KEY,
  menu_item_id INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  occurred_at TIMESTAMPTZ NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  source TEXT NOT NULL DEFAULT 'seed'
);
CREATE INDEX IF NOT EXISTS demand_history_time_idx ON demand_history(occurred_at, menu_item_id);

INSERT INTO menu_items (id, canteen_id, name, category, price_paise, is_veg, rating)
VALUES
  (1, 'MBA', 'Chicken Roll', 'Rolls', 8000, false, 4.7),
  (2, 'IT', 'Chicken Roll', 'Rolls', 7500, false, 4.5),
  (3, 'MBA', 'Paneer Roll', 'Rolls', 7000, true, 4.6),
  (4, 'MC', 'Veg Sandwich', 'Snacks', 4500, true, 4.4),
  (5, 'IT', 'Masala Dosa', 'Meals', 4500, true, 4.5),
  (6, 'MBA', 'Masala Dosa', 'Meals', 4000, true, 4.7),
  (7, 'MC', 'Fried Rice', 'Meals', 8500, true, 4.3),
  (8, 'IT', 'Veg Fried Rice', 'Meals', 9000, true, 4.5),
  (9, 'MBA', 'Samosa', 'Snacks', 2000, true, 4.8),
  (10, 'MC', 'Lime Juice', 'Drinks', 3000, true, 4.6),
  (11, 'MC', 'Paneer Roll', 'Rolls', 7500, true, 4.4),
  (12, 'IT', 'Tea', 'Drinks', 1500, true, 4.7)
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('menu_items', 'id'), GREATEST((SELECT COALESCE(MAX(id), 1) FROM menu_items), 1));

INSERT INTO demand_history (menu_item_id, occurred_at, quantity)
SELECT item.id, day.hour_bucket, (1 + ((item.id * 7 + EXTRACT(DOW FROM day.hour_bucket AT TIME ZONE 'Asia/Kolkata')::int) % 4))
FROM menu_items AS item
CROSS JOIN LATERAL generate_series(
  date_trunc('hour', now()) - INTERVAL '28 days',
  date_trunc('hour', now()) - INTERVAL '1 hour',
  INTERVAL '1 hour'
) AS day(hour_bucket)
WHERE EXTRACT(HOUR FROM day.hour_bucket AT TIME ZONE 'Asia/Kolkata')::int BETWEEN
  CASE WHEN item.category = 'Drinks' OR item.category = 'Snacks' THEN 14 ELSE 11 END
  AND CASE WHEN item.category = 'Drinks' OR item.category = 'Snacks' THEN 20 ELSE 14 END
  AND NOT EXISTS (SELECT 1 FROM demand_history WHERE source = 'seed' LIMIT 1);
