-- Part 14: persistent guest/account carts, explicit save-for-later storage,
-- and retry-safe cart mutations. Existing cart/wishlist rows are preserved.
--
-- The guest cookie itself is never stored: carts.session_id contains only the
-- digest of a cryptographically-random opaque cookie value. Cart prices remain
-- observations only; the catalog pricing and inventory tables are authoritative.

-- ── Append-only event vocabulary ─────────────────────────────────────────
ALTER TYPE cart_status ADD VALUE IF NOT EXISTS 'MERGED';
ALTER TYPE analytics_event_type ADD VALUE IF NOT EXISTS 'CART_CREATED';
ALTER TYPE analytics_event_type ADD VALUE IF NOT EXISTS 'CART_ITEM_ADDED';
ALTER TYPE analytics_event_type ADD VALUE IF NOT EXISTS 'CART_ITEM_UPDATED';
ALTER TYPE analytics_event_type ADD VALUE IF NOT EXISTS 'CART_ITEM_REMOVED';
ALTER TYPE analytics_event_type ADD VALUE IF NOT EXISTS 'CART_ITEM_SAVED';
ALTER TYPE analytics_event_type ADD VALUE IF NOT EXISTS 'CART_ITEM_RESTORED';
ALTER TYPE analytics_event_type ADD VALUE IF NOT EXISTS 'CART_MERGED';
ALTER TYPE analytics_event_type ADD VALUE IF NOT EXISTS 'CART_RECONCILED';
ALTER TYPE analytics_event_type ADD VALUE IF NOT EXISTS 'CART_ABANDONED';
ALTER TYPE analytics_event_type ADD VALUE IF NOT EXISTS 'CART_CONVERTED';
ALTER TYPE analytics_event_type ADD VALUE IF NOT EXISTS 'WISHLIST_TO_CART';
ALTER TYPE analytics_event_type ADD VALUE IF NOT EXISTS 'CART_EXPIRED';

-- ── Extend the existing cart tables ──────────────────────────────────────
ALTER TABLE carts ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'INR';
ALTER TABLE carts ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE carts ADD COLUMN IF NOT EXISTS last_activity_at timestamptz NOT NULL DEFAULT now();
UPDATE carts SET last_activity_at = updated_at;
-- Registered carts are owned by user_id; the guest session credential is kept
-- only on guest carts and is cleared from account carts.
UPDATE carts SET session_id = NULL WHERE user_id IS NOT NULL;

ALTER TABLE cart_items ADD COLUMN IF NOT EXISTS seller_id uuid;
ALTER TABLE cart_items ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'INR';
ALTER TABLE cart_items ADD COLUMN IF NOT EXISTS attribution_source text;
ALTER TABLE cart_items ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

-- Preserve existing seller attribution and currency snapshots before enforcing
-- the new read path.
UPDATE cart_items AS ci
   SET seller_id = p.seller_id
  FROM products AS p
 WHERE ci.product_id = p.id AND ci.seller_id IS NULL;
UPDATE cart_items AS ci
   SET currency = p.currency
  FROM products AS p
 WHERE ci.product_id = p.id;

DO $$ BEGIN
  ALTER TABLE cart_items
    ADD CONSTRAINT cart_items_seller_id_users_id_fk
    FOREIGN KEY (seller_id) REFERENCES users (id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE carts ADD CONSTRAINT carts_version_positive CHECK (version > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE carts ADD CONSTRAINT carts_currency_iso_code CHECK (currency ~ '^[A-Z]{3}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE cart_items ADD CONSTRAINT cart_items_version_positive CHECK (version > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE cart_items ADD CONSTRAINT cart_items_currency_iso_code CHECK (currency ~ '^[A-Z]{3}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The previous cart foundation did not enforce one ACTIVE row per owner. If
-- duplicates already exist, fold their lines into the most recently active
-- cart before adding partial unique indexes. Older carts stay as EXPIRED
-- audit history rather than becoming a second active basket.
WITH ranked AS (
  SELECT id,
         first_value(id) OVER (
           PARTITION BY coalesce('user:' || user_id::text, 'session:' || session_id)
           ORDER BY last_activity_at DESC, updated_at DESC, created_at DESC, id
         ) AS winner_id,
         row_number() OVER (
           PARTITION BY coalesce('user:' || user_id::text, 'session:' || session_id)
           ORDER BY last_activity_at DESC, updated_at DESC, created_at DESC, id
         ) AS row_num
    FROM carts
   WHERE status = 'ACTIVE' AND (user_id IS NOT NULL OR session_id IS NOT NULL)
), duplicates AS (
  SELECT id, winner_id FROM ranked WHERE row_num > 1
)
INSERT INTO cart_items (cart_id, product_id, variant_id, seller_id, quantity, unit_price, currency, attribution_source, version)
SELECT duplicates.winner_id,
       ci.product_id,
       ci.variant_id,
       (array_agg(ci.seller_id ORDER BY ci.created_at DESC))[1],
       least(10, sum(ci.quantity)::int),
       (array_agg(ci.unit_price ORDER BY ci.created_at DESC))[1],
       (array_agg(ci.currency ORDER BY ci.created_at DESC))[1],
       (array_agg(ci.attribution_source ORDER BY ci.created_at DESC))[1],
       1
  FROM duplicates
  JOIN cart_items AS ci ON ci.cart_id = duplicates.id
 GROUP BY duplicates.winner_id, ci.product_id, ci.variant_id
ON CONFLICT (cart_id, variant_id) DO UPDATE
  SET quantity = least(10, cart_items.quantity + EXCLUDED.quantity),
      seller_id = coalesce(cart_items.seller_id, EXCLUDED.seller_id),
      attribution_source = coalesce(cart_items.attribution_source, EXCLUDED.attribution_source),
      version = cart_items.version + 1,
      updated_at = now();

WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY coalesce('user:' || user_id::text, 'session:' || session_id)
           ORDER BY last_activity_at DESC, updated_at DESC, created_at DESC, id
         ) AS row_num
    FROM carts
   WHERE status = 'ACTIVE' AND (user_id IS NOT NULL OR session_id IS NOT NULL)
)
UPDATE carts
   SET status = 'EXPIRED', updated_at = now()
  WHERE id IN (SELECT id FROM ranked WHERE row_num > 1);

CREATE INDEX IF NOT EXISTS carts_abandonment_idx
  ON carts (status, last_activity_at) WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX IF NOT EXISTS carts_user_active_key
  ON carts (user_id) WHERE status = 'ACTIVE' AND user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS carts_session_active_key
  ON carts (session_id) WHERE status = 'ACTIVE' AND session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS cart_items_product_variant_idx
  ON cart_items (product_id, variant_id);

-- ── Save for Later (not a wishlist and never part of cart totals) ────────
CREATE TABLE IF NOT EXISTS saved_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id uuid NOT NULL,
  product_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  seller_id uuid,
  CONSTRAINT saved_items_cart_id_carts_id_fk FOREIGN KEY (cart_id) REFERENCES carts (id) ON DELETE CASCADE,
  CONSTRAINT saved_items_product_id_products_id_fk FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE,
  CONSTRAINT saved_items_variant_id_product_variants_id_fk FOREIGN KEY (variant_id) REFERENCES product_variants (id) ON DELETE CASCADE,
  CONSTRAINT saved_items_seller_id_users_id_fk FOREIGN KEY (seller_id) REFERENCES users (id) ON DELETE SET NULL,
  quantity integer NOT NULL,
  unit_price integer NOT NULL,
  currency text NOT NULL DEFAULT 'INR',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saved_items_quantity_positive CHECK (quantity > 0),
  CONSTRAINT saved_items_unit_price_non_negative CHECK (unit_price >= 0),
  CONSTRAINT saved_items_currency_iso_code CHECK (currency ~ '^[A-Z]{3}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS saved_items_cart_variant_key
  ON saved_items (cart_id, variant_id);
CREATE INDEX IF NOT EXISTS saved_items_cart_idx
  ON saved_items (cart_id, created_at);

-- ── Durable idempotency results (30-day retention is enforced by cleanup) ─
CREATE TABLE IF NOT EXISTS cart_mutation_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id uuid NOT NULL,
  key text NOT NULL,
  CONSTRAINT cart_mutation_keys_cart_id_carts_id_fk FOREIGN KEY (cart_id) REFERENCES carts (id) ON DELETE CASCADE,
  operation text NOT NULL,
  payload_hash text NOT NULL,
  response jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cart_mutation_keys_key_length CHECK (length(key) BETWEEN 8 AND 128)
);
CREATE UNIQUE INDEX IF NOT EXISTS cart_mutation_keys_cart_key
  ON cart_mutation_keys (cart_id, key);
CREATE INDEX IF NOT EXISTS cart_mutation_keys_expiry_idx
  ON cart_mutation_keys (expires_at);
