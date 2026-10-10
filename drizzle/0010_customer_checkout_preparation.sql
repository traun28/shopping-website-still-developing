-- Part 15: private customer profile preferences, international address-book
-- metadata, and owner-scoped checkout preparation. Checkout remains a
-- validation/review session only: this migration creates no orders, payments,
-- delivery quotes, taxes, or inventory reservations.

-- ── Address and checkout state vocabularies ──────────────────────────────
DO $$ BEGIN
  CREATE TYPE address_type AS ENUM ('HOME', 'WORK', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TYPE address_type ADD VALUE IF NOT EXISTS 'HOME';
ALTER TYPE address_type ADD VALUE IF NOT EXISTS 'WORK';
ALTER TYPE address_type ADD VALUE IF NOT EXISTS 'OTHER';

DO $$ BEGIN
  CREATE TYPE checkout_status AS ENUM (
    'CREATED', 'VALIDATING', 'NEEDS_ATTENTION', 'READY',
    'PAYMENT_PENDING', 'COMPLETED', 'EXPIRED', 'CANCELLED', 'FAILED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TYPE checkout_status ADD VALUE IF NOT EXISTS 'CREATED';
ALTER TYPE checkout_status ADD VALUE IF NOT EXISTS 'VALIDATING';
ALTER TYPE checkout_status ADD VALUE IF NOT EXISTS 'NEEDS_ATTENTION';
ALTER TYPE checkout_status ADD VALUE IF NOT EXISTS 'READY';
ALTER TYPE checkout_status ADD VALUE IF NOT EXISTS 'PAYMENT_PENDING';
ALTER TYPE checkout_status ADD VALUE IF NOT EXISTS 'COMPLETED';
ALTER TYPE checkout_status ADD VALUE IF NOT EXISTS 'EXPIRED';
ALTER TYPE checkout_status ADD VALUE IF NOT EXISTS 'CANCELLED';
ALTER TYPE checkout_status ADD VALUE IF NOT EXISTS 'FAILED';

-- The pre-Part-15 preferences table had a default-on marketing switch without
-- consent evidence. Turn off unrecorded opt-ins once, but never reset consent
-- after this migration has created its append-only history table.
DO $$ BEGIN
  IF to_regclass('public.marketing_consent_events') IS NULL THEN
    UPDATE user_preferences SET marketing_emails = false WHERE marketing_emails = true;
  END IF;
END $$;

ALTER TABLE user_preferences ALTER COLUMN marketing_emails SET DEFAULT false;
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS measurement_system text NOT NULL DEFAULT 'METRIC';
DO $$ BEGIN
  ALTER TABLE user_preferences
    ADD CONSTRAINT user_preferences_measurement_system
    CHECK (measurement_system IN ('METRIC', 'IMPERIAL'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS marketing_consent_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  consented boolean NOT NULL,
  source text NOT NULL,
  policy_version text NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT marketing_consent_events_user_id_users_id_fk
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS marketing_consent_events_user_created_idx
  ON marketing_consent_events USING btree (user_id, created_at);

-- ── Country-aware customer address book ──────────────────────────────────
ALTER TABLE addresses ADD COLUMN IF NOT EXISTS locality text;
ALTER TABLE addresses ADD COLUMN IF NOT EXISTS delivery_instructions text;
ALTER TABLE addresses ADD COLUMN IF NOT EXISTS address_type address_type DEFAULT 'HOME' NOT NULL;
ALTER TABLE addresses ADD COLUMN IF NOT EXISTS is_default_billing boolean DEFAULT false NOT NULL;
ALTER TABLE addresses ADD COLUMN IF NOT EXISTS version integer DEFAULT 1 NOT NULL;
ALTER TABLE addresses ALTER COLUMN state DROP NOT NULL;
ALTER TABLE addresses ALTER COLUMN postal_code DROP NOT NULL;

-- Preserve one deterministic legacy shipping default per customer before
-- enforcing the partial unique indexes (older installations did not enforce
-- this invariant in PostgreSQL).
WITH ranked_defaults AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY user_id
           ORDER BY updated_at DESC, created_at ASC, id ASC
         ) AS preference_rank
    FROM addresses
   WHERE is_default = true
)
UPDATE addresses AS address
   SET is_default = false
  FROM ranked_defaults AS ranked
 WHERE address.id = ranked.id
   AND ranked.preference_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS addresses_user_default_shipping_key
  ON addresses USING btree (user_id) WHERE is_default = true;
CREATE UNIQUE INDEX IF NOT EXISTS addresses_user_default_billing_key
  ON addresses USING btree (user_id) WHERE is_default_billing = true;
DO $$ BEGIN
  ALTER TABLE addresses
    ADD CONSTRAINT addresses_country_iso_code
    CHECK (country ~ '^[A-Z]{2}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE addresses
    ADD CONSTRAINT addresses_version_positive
    CHECK (version > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Checkout-only behavioral event vocabulary ────────────────────────────
ALTER TYPE analytics_event_type ADD VALUE IF NOT EXISTS 'CHECKOUT_ADDRESS_SELECTED';
ALTER TYPE analytics_event_type ADD VALUE IF NOT EXISTS 'CHECKOUT_ADDRESS_CHANGED';
ALTER TYPE analytics_event_type ADD VALUE IF NOT EXISTS 'CHECKOUT_DELIVERY_SELECTED';
ALTER TYPE analytics_event_type ADD VALUE IF NOT EXISTS 'CHECKOUT_REVALIDATED';
ALTER TYPE analytics_event_type ADD VALUE IF NOT EXISTS 'CHECKOUT_NEEDS_ATTENTION';
ALTER TYPE analytics_event_type ADD VALUE IF NOT EXISTS 'CHECKOUT_READY';
ALTER TYPE analytics_event_type ADD VALUE IF NOT EXISTS 'CHECKOUT_CANCELLED';
ALTER TYPE analytics_event_type ADD VALUE IF NOT EXISTS 'CHECKOUT_EXPIRED';
ALTER TYPE analytics_event_type ADD VALUE IF NOT EXISTS 'CHECKOUT_FAILED';

-- ── Versioned customer-owned checkout preparation sessions ──────────────
CREATE TABLE IF NOT EXISTS checkout_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid,
  guest_session_hash text,
  cart_id uuid,
  create_idempotency_key text NOT NULL,
  create_request_hash text NOT NULL,
  status checkout_status DEFAULT 'CREATED' NOT NULL,
  version integer DEFAULT 1 NOT NULL,
  cart_version integer DEFAULT 0 NOT NULL,
  currency text DEFAULT 'INR' NOT NULL,
  contact_snapshot jsonb,
  shipping_address_id uuid,
  shipping_address_snapshot jsonb,
  billing_address_id uuid,
  billing_address_snapshot jsonb,
  billing_same_as_shipping boolean DEFAULT true NOT NULL,
  selected_delivery_method_id text,
  selected_delivery_snapshot jsonb,
  items_snapshot jsonb DEFAULT '[]'::jsonb NOT NULL,
  totals_snapshot jsonb,
  validation_issues jsonb DEFAULT '[]'::jsonb NOT NULL,
  validated_at timestamptz,
  expires_at timestamptz NOT NULL,
  pii_purge_at timestamptz NOT NULL,
  pii_purged_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT checkout_sessions_user_id_users_id_fk
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT checkout_sessions_cart_id_carts_id_fk
    FOREIGN KEY (cart_id) REFERENCES carts (id) ON DELETE SET NULL,
  CONSTRAINT checkout_sessions_shipping_address_id_addresses_id_fk
    FOREIGN KEY (shipping_address_id) REFERENCES addresses (id) ON DELETE SET NULL,
  CONSTRAINT checkout_sessions_billing_address_id_addresses_id_fk
    FOREIGN KEY (billing_address_id) REFERENCES addresses (id) ON DELETE SET NULL,
  CONSTRAINT checkout_sessions_version_positive CHECK (version > 0),
  CONSTRAINT checkout_sessions_cart_version_non_negative CHECK (cart_version >= 0),
  CONSTRAINT checkout_sessions_currency_iso_code CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT checkout_sessions_guest_hash_shape
    CHECK (guest_session_hash IS NULL OR guest_session_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT checkout_sessions_create_key_length
    CHECK (length(create_idempotency_key) BETWEEN 8 AND 128)
);
CREATE INDEX IF NOT EXISTS checkout_sessions_user_status_expires_idx
  ON checkout_sessions USING btree (user_id, status, expires_at);
CREATE INDEX IF NOT EXISTS checkout_sessions_guest_status_expires_idx
  ON checkout_sessions USING btree (guest_session_hash, status, expires_at);
CREATE INDEX IF NOT EXISTS checkout_sessions_cart_status_idx
  ON checkout_sessions USING btree (cart_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS checkout_sessions_user_create_key
  ON checkout_sessions USING btree (user_id, create_idempotency_key)
  WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS checkout_sessions_guest_create_key
  ON checkout_sessions USING btree (guest_session_hash, create_idempotency_key)
  WHERE guest_session_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS checkout_mutation_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  checkout_session_id uuid NOT NULL,
  key text NOT NULL,
  operation text NOT NULL,
  payload_hash text NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  expires_at timestamptz NOT NULL,
  CONSTRAINT checkout_mutation_keys_checkout_session_id_checkout_sessions_id
    FOREIGN KEY (checkout_session_id) REFERENCES checkout_sessions (id) ON DELETE CASCADE,
  CONSTRAINT checkout_mutation_keys_key_length CHECK (length(key) BETWEEN 8 AND 128)
);
CREATE UNIQUE INDEX IF NOT EXISTS checkout_mutation_keys_session_key
  ON checkout_mutation_keys USING btree (checkout_session_id, key);
CREATE INDEX IF NOT EXISTS checkout_mutation_keys_expiry_idx
  ON checkout_mutation_keys USING btree (expires_at);
