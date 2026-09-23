/**
 * SQLite schema, applied in order by `SqliteOrderStore`. Append-only: never edit an applied migration,
 * add a new one. Ids are recorded in `schema_migrations`.
 */
export interface Migration {
  id: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: '0001_initial',
    sql: `
CREATE TABLE orders (
  id            TEXT PRIMARY KEY,
  product       TEXT NOT NULL CHECK (product IN ('blockspace','scribbit','degent')),
  customer_ref  TEXT NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'sat' CHECK (currency = 'sat'),
  total_sats    INTEGER NOT NULL CHECK (total_sats >= 0),
  status        TEXT NOT NULL CHECK (status IN ('created','awaiting_payment','paid','expired','cancelled','refunded')),
  line_items    TEXT NOT NULL,             -- JSON array of LineItem
  metadata      TEXT NOT NULL DEFAULT '{}', -- JSON object of string values
  version       INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX orders_product_customer ON orders (product, customer_ref);
CREATE INDEX orders_status ON orders (status);

CREATE TABLE payments (
  id               TEXT PRIMARY KEY,
  order_id         TEXT NOT NULL REFERENCES orders(id),
  product          TEXT NOT NULL,
  method           TEXT NOT NULL CHECK (method IN ('onchain','lightning','card')),
  provider         TEXT NOT NULL,
  provider_ref     TEXT NOT NULL,
  amount_sats      INTEGER NOT NULL CHECK (amount_sats >= 0),
  amount_paid_sats INTEGER NOT NULL DEFAULT 0 CHECK (amount_paid_sats >= 0),
  refunded_sats    INTEGER NOT NULL DEFAULT 0 CHECK (refunded_sats >= 0),
  status           TEXT NOT NULL CHECK (status IN ('created','pending','paid','underpaid','overpaid','expired','failed','refunded')),
  checkout         TEXT NOT NULL DEFAULT '{}', -- JSON CheckoutDetails (never card data)
  expires_at       TEXT,
  paid_at          TEXT,
  txid             TEXT,
  preimage         TEXT,
  provider_data    TEXT NOT NULL DEFAULT '{}',
  version          INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (provider, provider_ref)
);
CREATE INDEX payments_order ON payments (order_id);
CREATE INDEX payments_status ON payments (status, created_at);

CREATE TABLE refunds (
  id            TEXT PRIMARY KEY,
  payment_id    TEXT NOT NULL REFERENCES payments(id),
  order_id      TEXT NOT NULL REFERENCES orders(id),
  amount_sats   INTEGER NOT NULL CHECK (amount_sats > 0),
  status        TEXT NOT NULL CHECK (status IN ('pending','completed','failed')),
  reason        TEXT NOT NULL,
  provider_ref  TEXT,
  destination   TEXT,
  detail        TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX refunds_payment ON refunds (payment_id);
CREATE INDEX refunds_order ON refunds (order_id);

CREATE TABLE idempotency_keys (
  scope         TEXT NOT NULL,
  key           TEXT NOT NULL,
  fingerprint   TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id   TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (scope, key)
);

CREATE TABLE webhook_deliveries (
  provider     TEXT NOT NULL,
  delivery_id  TEXT NOT NULL,
  received_at  TEXT NOT NULL,
  PRIMARY KEY (provider, delivery_id)
);

CREATE TABLE address_indexes (
  scope TEXT PRIMARY KEY,
  next  INTEGER NOT NULL DEFAULT 0
);
`,
  },
];
