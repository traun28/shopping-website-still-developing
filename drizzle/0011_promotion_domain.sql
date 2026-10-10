-- Part 16: typed, persisted promotions and temporary checkout reservations.
-- This migration extends the existing coupon schema instead of replacing it.
-- It deliberately does not create orders, payments, shipping quotes, tax
-- calculations, or a redemption-completion hook.

-- ── Promotion lifecycle events use the existing transactional outbox ─────
ALTER TYPE catalog_event_type ADD VALUE IF NOT EXISTS 'PROMOTION_CREATED';
ALTER TYPE catalog_event_type ADD VALUE IF NOT EXISTS 'PROMOTION_UPDATED';
ALTER TYPE catalog_event_type ADD VALUE IF NOT EXISTS 'PROMOTION_ACTIVATED';
ALTER TYPE catalog_event_type ADD VALUE IF NOT EXISTS 'PROMOTION_PAUSED';
ALTER TYPE catalog_event_type ADD VALUE IF NOT EXISTS 'PROMOTION_ARCHIVED';
ALTER TYPE catalog_event_type ADD VALUE IF NOT EXISTS 'CAMPAIGN_CREATED';
ALTER TYPE catalog_event_type ADD VALUE IF NOT EXISTS 'CAMPAIGN_UPDATED';
ALTER TYPE catalog_event_type ADD VALUE IF NOT EXISTS 'CAMPAIGN_ACTIVATED';
ALTER TYPE catalog_event_type ADD VALUE IF NOT EXISTS 'CAMPAIGN_PAUSED';
ALTER TYPE catalog_event_type ADD VALUE IF NOT EXISTS 'CAMPAIGN_ARCHIVED';
ALTER TYPE catalog_event_type ADD VALUE IF NOT EXISTS 'PROMOTION_RESERVED';
ALTER TYPE catalog_event_type ADD VALUE IF NOT EXISTS 'PROMOTION_RELEASED';
ALTER TYPE catalog_event_type ADD VALUE IF NOT EXISTS 'COUPON_APPLIED';
ALTER TYPE catalog_event_type ADD VALUE IF NOT EXISTS 'COUPON_REMOVED';

-- Coupon interaction analytics shares the existing behavioral event stream.
ALTER TYPE analytics_event_type ADD VALUE IF NOT EXISTS 'CHECKOUT_COUPON_APPLIED';
ALTER TYPE analytics_event_type ADD VALUE IF NOT EXISTS 'CHECKOUT_COUPON_REMOVED';

-- Preserve case-insensitive code uniqueness before normalizing existing rows.
DO $$ BEGIN
  IF EXISTS (
    SELECT upper(btrim(code))
      FROM coupons
     GROUP BY upper(btrim(code))
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot normalize coupons: duplicate codes differ only by case or surrounding whitespace';
  END IF;
END $$;
UPDATE coupons SET code = upper(btrim(code)) WHERE code <> upper(btrim(code));

CREATE TABLE IF NOT EXISTS promotion_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  name text NOT NULL,
  slug text NOT NULL,
  description text,
  status text DEFAULT 'DRAFT' NOT NULL,
  timezone text DEFAULT 'UTC' NOT NULL,
  starts_at timestamptz,
  ends_at timestamptz,
  version integer DEFAULT 1 NOT NULL,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT promotion_campaigns_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT promotion_campaigns_updated_by_users_id_fk FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT promotion_campaigns_status_valid CHECK (status IN ('DRAFT', 'SCHEDULED', 'ACTIVE', 'PAUSED', 'ENDED', 'ARCHIVED')),
  CONSTRAINT promotion_campaigns_version_positive CHECK (version > 0),
  CONSTRAINT promotion_campaigns_window_valid CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS promotion_campaigns_slug_key ON promotion_campaigns USING btree (slug);
CREATE INDEX IF NOT EXISTS promotion_campaigns_status_window_idx ON promotion_campaigns USING btree (status, starts_at, ends_at);

CREATE TABLE IF NOT EXISTS promotions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  campaign_id uuid,
  name text NOT NULL,
  description text,
  strategy text NOT NULL,
  status text DEFAULT 'DRAFT' NOT NULL,
  discount_config jsonb NOT NULL,
  eligibility jsonb DEFAULT '{}'::jsonb NOT NULL,
  priority integer DEFAULT 100 NOT NULL,
  stackable boolean DEFAULT false NOT NULL,
  stack_group text,
  is_automatic boolean DEFAULT true NOT NULL,
  apply_to_catalog boolean DEFAULT false NOT NULL,
  currency text DEFAULT 'INR' NOT NULL,
  total_usage_limit integer,
  per_customer_usage_limit integer,
  starts_at timestamptz,
  ends_at timestamptz,
  timezone text DEFAULT 'UTC' NOT NULL,
  version integer DEFAULT 1 NOT NULL,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT promotions_campaign_id_promotion_campaigns_id_fk FOREIGN KEY (campaign_id) REFERENCES promotion_campaigns(id) ON DELETE SET NULL,
  CONSTRAINT promotions_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT promotions_updated_by_users_id_fk FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT promotions_strategy_valid CHECK (strategy IN ('PERCENTAGE_OFF', 'FIXED_AMOUNT_OFF', 'CART_THRESHOLD', 'QUANTITY_TIER', 'BUY_X_GET_Y', 'BUNDLE', 'FREE_SHIPPING')),
  CONSTRAINT promotions_status_valid CHECK (status IN ('DRAFT', 'SCHEDULED', 'ACTIVE', 'PAUSED', 'ENDED', 'ARCHIVED')),
  CONSTRAINT promotions_priority_non_negative CHECK (priority >= 0),
  CONSTRAINT promotions_version_positive CHECK (version > 0),
  CONSTRAINT promotions_currency_iso_code CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT promotions_total_limit_positive CHECK (total_usage_limit IS NULL OR total_usage_limit > 0),
  CONSTRAINT promotions_customer_limit_positive CHECK (per_customer_usage_limit IS NULL OR per_customer_usage_limit > 0),
  CONSTRAINT promotions_window_valid CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at),
  CONSTRAINT promotions_catalog_automatic_only CHECK (apply_to_catalog = false OR (is_automatic = true AND total_usage_limit IS NULL AND per_customer_usage_limit IS NULL))
);
CREATE INDEX IF NOT EXISTS promotions_status_window_idx ON promotions USING btree (status, starts_at, ends_at);
CREATE INDEX IF NOT EXISTS promotions_campaign_idx ON promotions USING btree (campaign_id, status);

-- One target table keeps product/category/brand/seller/collection/customer
-- criteria normalized and queryable. Target IDs are validated against their
-- dimension by the typed admin service (cross-table FKs are not possible here).
CREATE TABLE IF NOT EXISTS promotion_targets (
  promotion_id uuid NOT NULL,
  dimension text NOT NULL,
  entity_id uuid NOT NULL,
  mode text DEFAULT 'INCLUDE' NOT NULL,
  CONSTRAINT promotion_targets_promotion_id_promotions_id_fk FOREIGN KEY (promotion_id) REFERENCES promotions(id) ON DELETE CASCADE,
  CONSTRAINT promotion_targets_promotion_id_dimension_entity_id_mode_pk PRIMARY KEY (promotion_id, dimension, entity_id, mode),
  CONSTRAINT promotion_targets_dimension_valid CHECK (dimension IN ('PRODUCT', 'CATEGORY', 'BRAND', 'SELLER', 'COLLECTION', 'CUSTOMER')),
  CONSTRAINT promotion_targets_mode_valid CHECK (mode IN ('INCLUDE', 'EXCLUDE'))
);
CREATE INDEX IF NOT EXISTS promotion_targets_entity_idx ON promotion_targets USING btree (dimension, entity_id, promotion_id);

CREATE TABLE IF NOT EXISTS promotion_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  promotion_id uuid,
  campaign_id uuid,
  version integer NOT NULL,
  snapshot jsonb NOT NULL,
  actor_id uuid,
  created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT promotion_versions_promotion_id_promotions_id_fk FOREIGN KEY (promotion_id) REFERENCES promotions(id) ON DELETE CASCADE,
  CONSTRAINT promotion_versions_campaign_id_promotion_campaigns_id_fk FOREIGN KEY (campaign_id) REFERENCES promotion_campaigns(id) ON DELETE CASCADE,
  CONSTRAINT promotion_versions_actor_id_users_id_fk FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT promotion_versions_one_owner CHECK ((promotion_id IS NOT NULL) <> (campaign_id IS NOT NULL)),
  CONSTRAINT promotion_versions_version_positive CHECK (version > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS promotion_versions_promotion_version_key ON promotion_versions USING btree (promotion_id, version) WHERE promotion_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS promotion_versions_campaign_version_key ON promotion_versions USING btree (campaign_id, version) WHERE campaign_id IS NOT NULL;

ALTER TABLE coupons ADD COLUMN IF NOT EXISTS promotion_id uuid;
DO $$ BEGIN
  ALTER TABLE coupons ADD CONSTRAINT coupons_promotion_id_promotions_id_fk
    FOREIGN KEY (promotion_id) REFERENCES promotions(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS coupons_promotion_idx ON coupons USING btree (promotion_id);

-- Backfill the existing coupon table into the new rule engine without
-- inventing production coupons or discarding legacy targeting/usage metadata.
INSERT INTO promotions (
  id, name, description, strategy, status, discount_config, eligibility,
  priority, stackable, is_automatic, currency, total_usage_limit,
  per_customer_usage_limit, starts_at, ends_at, version, created_at, updated_at
)
SELECT
  c.id,
  'Legacy coupon ' || c.code,
  'Backfilled from the pre-Part-16 coupon row.',
  CASE c.type WHEN 'PERCENTAGE' THEN 'PERCENTAGE_OFF' WHEN 'FIXED_AMOUNT' THEN 'FIXED_AMOUNT_OFF' ELSE 'FREE_SHIPPING' END,
  CASE WHEN c.is_active AND c.type <> 'FREE_SHIPPING' THEN 'ACTIVE' ELSE 'PAUSED' END,
  CASE c.type
    WHEN 'PERCENTAGE' THEN jsonb_build_object('strategy', 'PERCENTAGE_OFF', 'discountBasisPoints', c.value * 100, 'maxDiscountPaise', c.maximum_discount_amount)
    WHEN 'FIXED_AMOUNT' THEN jsonb_build_object('strategy', 'FIXED_AMOUNT_OFF', 'amountPaise', c.value)
    ELSE jsonb_build_object('strategy', 'FREE_SHIPPING')
  END,
  CASE WHEN c.minimum_order_amount IS NULL THEN '{}'::jsonb
       ELSE jsonb_build_object('minimumCartSubtotalPaise', c.minimum_order_amount) END,
  100, false, false, 'INR', c.usage_limit, c.per_user_limit,
  c.starts_at, c.expires_at, 1, c.created_at, c.updated_at
FROM coupons c
ON CONFLICT (id) DO NOTHING;
UPDATE coupons SET promotion_id = id WHERE promotion_id IS NULL;

INSERT INTO promotion_targets (promotion_id, dimension, entity_id, mode)
SELECT cp.coupon_id, 'PRODUCT', cp.product_id, 'INCLUDE' FROM coupon_products cp
ON CONFLICT DO NOTHING;
INSERT INTO promotion_targets (promotion_id, dimension, entity_id, mode)
SELECT cc.coupon_id, 'CATEGORY', cc.category_id, 'INCLUDE' FROM coupon_categories cc
ON CONFLICT DO NOTHING;
INSERT INTO promotion_targets (promotion_id, dimension, entity_id, mode)
SELECT cc.coupon_id, 'COLLECTION', cc.collection_id, 'INCLUDE' FROM coupon_collections cc
ON CONFLICT DO NOTHING;
INSERT INTO promotion_targets (promotion_id, dimension, entity_id, mode)
SELECT cc.coupon_id, 'CUSTOMER', cc.user_id, 'INCLUDE' FROM coupon_customers cc
ON CONFLICT DO NOTHING;

-- The backfilled rule starts at version one too, so its exact migrated state is
-- visible to the same version history used for subsequent admin edits. Target
-- IDs are retained, but coupon codes are deliberately never copied into audit.
INSERT INTO promotion_versions (promotion_id, version, snapshot, actor_id)
SELECT p.id, p.version,
       to_jsonb(p) || jsonb_build_object(
         'targets', COALESCE((
           SELECT jsonb_agg(jsonb_build_object('dimension', t.dimension, 'entityId', t.entity_id, 'mode', t.mode)
                            ORDER BY t.dimension, t.entity_id, t.mode)
             FROM promotion_targets t WHERE t.promotion_id = p.id
         ), '[]'::jsonb),
         'couponConfigured', EXISTS (SELECT 1 FROM coupons c WHERE c.promotion_id = p.id)
       ),
       NULL
  FROM promotions p
 WHERE NOT EXISTS (
   SELECT 1 FROM promotion_versions v
    WHERE v.promotion_id = p.id AND v.version = p.version
 )
ON CONFLICT DO NOTHING;

CREATE UNIQUE INDEX IF NOT EXISTS coupons_code_normalized_key ON coupons USING btree (upper(code));

ALTER TABLE checkout_sessions ADD COLUMN IF NOT EXISTS coupon_id uuid;
ALTER TABLE checkout_sessions ADD COLUMN IF NOT EXISTS coupon_code text;

CREATE TABLE IF NOT EXISTS promotion_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  promotion_id uuid NOT NULL,
  coupon_id uuid,
  checkout_session_id uuid NOT NULL,
  order_id uuid,
  user_id uuid,
  idempotency_key text NOT NULL,
  status text DEFAULT 'RESERVED' NOT NULL,
  discount_paise integer DEFAULT 0 NOT NULL,
  currency text DEFAULT 'INR' NOT NULL,
  allocations jsonb DEFAULT '[]'::jsonb NOT NULL,
  reserved_at timestamptz DEFAULT now() NOT NULL,
  expires_at timestamptz NOT NULL,
  released_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT promotion_redemptions_promotion_id_promotions_id_fk FOREIGN KEY (promotion_id) REFERENCES promotions(id) ON DELETE RESTRICT,
  CONSTRAINT promotion_redemptions_coupon_id_coupons_id_fk FOREIGN KEY (coupon_id) REFERENCES coupons(id) ON DELETE SET NULL,
  CONSTRAINT promotion_redemptions_checkout_session_id_checkout_sessions_id_fk FOREIGN KEY (checkout_session_id) REFERENCES checkout_sessions(id) ON DELETE CASCADE,
  CONSTRAINT promotion_redemptions_order_id_orders_id_fk FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL,
  CONSTRAINT promotion_redemptions_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT promotion_redemptions_status_valid CHECK (status IN ('RESERVED', 'REDEEMED', 'RELEASED', 'EXPIRED')),
  CONSTRAINT promotion_redemptions_currency_iso_code CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT promotion_redemptions_discount_paise_non_negative CHECK (discount_paise >= 0),
  CONSTRAINT promotion_redemptions_order_redeemed_only CHECK (status != 'REDEEMED' OR order_id IS NOT NULL),
  CONSTRAINT promotion_redemptions_release_timestamp CHECK (status NOT IN ('RELEASED', 'EXPIRED') OR released_at IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS promotion_redemptions_idempotency_key ON promotion_redemptions USING btree (idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS promotion_redemptions_checkout_active_key ON promotion_redemptions USING btree (checkout_session_id, promotion_id) WHERE status = 'RESERVED';
CREATE INDEX IF NOT EXISTS promotion_redemptions_capacity_idx ON promotion_redemptions USING btree (promotion_id, status, expires_at);
CREATE INDEX IF NOT EXISTS promotion_redemptions_coupon_customer_idx ON promotion_redemptions USING btree (coupon_id, user_id, status);
CREATE INDEX IF NOT EXISTS promotion_redemptions_checkout_idx ON promotion_redemptions USING btree (checkout_session_id, status);
