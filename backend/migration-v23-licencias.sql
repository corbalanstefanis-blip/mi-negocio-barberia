-- MI NEGOCIO ADMIN / LICENCIAS v1
-- Preparado para Cloudflare D1. No ejecutar todavía en producción.

CREATE TABLE IF NOT EXISTS business_subscriptions (
  slug TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  plan_code TEXT NOT NULL DEFAULT 'barberia',
  cohort TEXT NOT NULL DEFAULT 'standard',
  founder_slot INTEGER,
  intro_cycles_total INTEGER NOT NULL DEFAULT 0,
  intro_cycles_used INTEGER NOT NULL DEFAULT 0,
  discount_pct REAL NOT NULL DEFAULT 0,
  list_price_cents INTEGER NOT NULL DEFAULT 1490000,
  effective_price_cents INTEGER NOT NULL DEFAULT 1490000,
  currency TEXT NOT NULL DEFAULT 'ARS',
  current_period_start TEXT,
  current_period_end TEXT,
  grace_until TEXT,
  suspended_at TEXT,
  archived_at TEXT,
  deletion_review_at TEXT,
  cancellation_requested_at TEXT,
  cancellation_effective_at TEXT,
  cancellation_request_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  note TEXT
);

CREATE TABLE IF NOT EXISTS subscription_payments (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_payment_id TEXT,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'ARS',
  status TEXT NOT NULL,
  period_start TEXT,
  period_end TEXT,
  paid_at TEXT,
  refunded_at TEXT,
  created_at TEXT NOT NULL,
  raw_ref TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_provider_id
ON subscription_payments(provider, provider_payment_id);

CREATE INDEX IF NOT EXISTS idx_payments_slug
ON subscription_payments(slug, created_at);

CREATE TABLE IF NOT EXISTS pricing_versions (
  id TEXT PRIMARY KEY,
  list_price_cents INTEGER NOT NULL,
  founder_discount_pct REAL NOT NULL DEFAULT 20,
  effective_from TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT
);

CREATE TABLE IF NOT EXISTS pricing_reviews (
  month TEXT PRIMARY KEY,
  reviewed_at TEXT NOT NULL,
  decision TEXT NOT NULL,
  old_price_cents INTEGER NOT NULL,
  new_price_cents INTEGER NOT NULL,
  inflation_pct REAL,
  notes TEXT,
  created_by TEXT
);

CREATE TABLE IF NOT EXISTS platform_users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen TEXT
);

CREATE TABLE IF NOT EXISTS admin_audit (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT,
  action TEXT NOT NULL,
  target_slug TEXT,
  details_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS policy_acceptances (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  accepted_by TEXT,
  acceptance_channel TEXT,
  metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_status
ON business_subscriptions(status, current_period_end);

CREATE INDEX IF NOT EXISTS idx_audit_created
ON admin_audit(created_at);

CREATE INDEX IF NOT EXISTS idx_policy_slug
ON policy_acceptances(slug, accepted_at);
