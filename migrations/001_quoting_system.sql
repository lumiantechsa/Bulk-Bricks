-- Shared database for the quoting system: staff, catalogue, pricing variables,
-- quotations and chats. Money uses numeric (exact decimals), never float.

CREATE TABLE settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Staff accounts. role is admin or sales; permissions holds extra grants
-- (e.g. a salesperson allowed to manage pricing).
CREATE TABLE staff_users (
  id text PRIMARY KEY,
  username text NOT NULL UNIQUE,
  name text NOT NULL,
  email text NOT NULL DEFAULT '',
  role text NOT NULL CHECK (role IN ('admin', 'sales')),
  permissions text[] NOT NULL DEFAULT '{}',
  password_hash text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE staff_sessions (
  token_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE TABLE product_categories (
  key text PRIMARY KEY,
  name text NOT NULL,
  -- material: priced as a job material (pallets, weight, labour);
  -- accessory / service: added to a quote as an extra by SKU.
  kind text NOT NULL CHECK (kind IN ('material', 'accessory', 'service')),
  sort_order integer NOT NULL DEFAULT 0
);

CREATE TABLE products (
  id text PRIMARY KEY,
  sku text NOT NULL UNIQUE,
  name text NOT NULL,
  category_key text NOT NULL REFERENCES product_categories(key),
  description text NOT NULL DEFAULT '',
  unit text NOT NULL,
  unit_price numeric(12,2) NOT NULL CHECK (unit_price >= 0),
  vat_treatment text NOT NULL DEFAULT 'standard' CHECK (vat_treatment IN ('standard', 'zero_rated', 'exempt')),
  length_mm numeric(10,1),
  width_mm numeric(10,1),
  height_mm numeric(10,1),
  size_verified boolean NOT NULL DEFAULT false,
  layout text CHECK (layout IN ('wall', 'paving')),
  coverage_per_m2 numeric(10,3),
  units_per_pallet numeric(10,2),
  weight_kg numeric(10,3),
  default_wastage_percent numeric(5,2),
  colour text,
  finish text,
  colour_options text[],
  finish_options text[],
  labour_basis text CHECK (labour_basis IN ('area', 'quantity')),
  labour_rate numeric(12,2),
  delivery_requirement text NOT NULL DEFAULT 'none' CHECK (delivery_requirement IN ('none', 'forklift', 'crane')),
  min_quantity numeric(12,3),
  volume_tiers jsonb NOT NULL DEFAULT '[]',
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1,
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX products_category_idx ON products (category_key);

-- Append-only record of every price change.
CREATE TABLE product_price_history (
  id bigserial PRIMARY KEY,
  product_id text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  field text NOT NULL,
  old_value numeric(12,2),
  new_value numeric(12,2),
  changed_by text,
  changed_by_name text NOT NULL DEFAULT '',
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX product_price_history_product_idx ON product_price_history (product_id, changed_at DESC);

-- Rates the calculation engine uses (delivery brackets, vehicles, pallet fees,
-- offloading, labour factors, discounts, surcharges) plus staff-defined
-- adjustments. kind decides which fields are valid and how the engine uses them.
CREATE TABLE pricing_variables (
  id text PRIMARY KEY,
  kind text NOT NULL,
  name text NOT NULL,
  data_type text NOT NULL DEFAULT 'number',
  unit text NOT NULL DEFAULT '',
  value numeric(14,4),
  fields jsonb NOT NULL DEFAULT '{}',
  categories text[] NOT NULL DEFAULT '{}',
  rule text,
  description text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE SEQUENCE quotation_number_seq;

CREATE TABLE quotations (
  id text PRIMARY KEY,
  number text NOT NULL UNIQUE,
  conversation_id text,
  status text NOT NULL CHECK (status IN ('draft', 'pending_review', 'sent', 'accepted', 'rejected')),
  customer jsonb NOT NULL DEFAULT '{}',
  project_name text NOT NULL DEFAULT '',
  site_address text NOT NULL DEFAULT '',
  project_summary text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  staff_note text NOT NULL DEFAULT '',
  -- Inputs, so the quotation can be edited and recalculated.
  job jsonb,
  extras jsonb NOT NULL DEFAULT '[]',
  custom_lines jsonb NOT NULL DEFAULT '[]',
  overrides jsonb NOT NULL DEFAULT '{}',
  -- Prices and rates used, frozen when the quotation was saved.
  pricing_snapshot jsonb NOT NULL,
  details jsonb,
  currency text NOT NULL,
  subtotal numeric(14,2) NOT NULL,
  discount_percent numeric(5,2) NOT NULL DEFAULT 0,
  discount numeric(14,2) NOT NULL DEFAULT 0,
  tax_rate_percent numeric(5,2) NOT NULL,
  tax numeric(14,2) NOT NULL,
  total numeric(14,2) NOT NULL,
  valid_until date,
  version integer NOT NULL DEFAULT 1,
  created_by text,
  created_by_name text NOT NULL DEFAULT '',
  updated_by text,
  updated_by_name text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  deleted_at timestamptz,
  deleted_by text
);
CREATE INDEX quotations_updated_idx ON quotations (updated_at DESC);
CREATE INDEX quotations_conversation_idx ON quotations (conversation_id);

CREATE TABLE quotation_line_items (
  quotation_id text NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  position integer NOT NULL,
  code text,
  sku text,
  name text NOT NULL,
  detail text NOT NULL DEFAULT '',
  unit text NOT NULL DEFAULT '',
  quantity numeric(14,3) NOT NULL,
  unit_price numeric(14,2) NOT NULL,
  list_unit_price numeric(14,2),
  line_total numeric(14,2) NOT NULL,
  volume_discount_percent numeric(5,2) NOT NULL DEFAULT 0,
  material boolean NOT NULL DEFAULT false,
  vat_exempt boolean NOT NULL DEFAULT false,
  overridden boolean NOT NULL DEFAULT false,
  PRIMARY KEY (quotation_id, position)
);

-- Full copy of the quotation after every save, so changes can be traced.
CREATE TABLE quotation_revisions (
  id bigserial PRIMARY KEY,
  quotation_id text NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  action text NOT NULL,
  summary text NOT NULL DEFAULT '',
  snapshot jsonb NOT NULL,
  changed_by text,
  changed_by_name text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (quotation_id, revision)
);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  user_id text,
  user_name text NOT NULL DEFAULT '',
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  details jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_log_at_idx ON audit_log (at DESC);

-- Quoting assistant chats.
CREATE TABLE conversations (
  id text PRIMARY KEY,
  token text NOT NULL,
  staff_user_id text,
  status text NOT NULL DEFAULT 'active',
  ai_paused boolean NOT NULL DEFAULT false,
  provider text,
  system_prompt text,
  customer jsonb NOT NULL DEFAULT '{}',
  job jsonb,
  draft_quotation_id text,
  messages jsonb NOT NULL DEFAULT '[]',
  transcript jsonb NOT NULL DEFAULT '[]',
  pending jsonb NOT NULL DEFAULT '[]',
  escalation jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversations_updated_idx ON conversations (updated_at DESC);
