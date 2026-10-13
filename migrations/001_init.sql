CREATE TABLE metrics (
  client_id TEXT NOT NULL,
  source TEXT NOT NULL,
  metric TEXT NOT NULL,
  dimension TEXT NOT NULL DEFAULT '',
  period TEXT NOT NULL CHECK (period IN ('day', 'month')),
  date TEXT NOT NULL,
  value REAL NOT NULL,
  PRIMARY KEY (client_id, source, metric, dimension, period, date)
) WITHOUT ROWID;

CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  client_id TEXT NOT NULL,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  type TEXT NOT NULL,
  ts TEXT NOT NULL,
  title TEXT NOT NULL,
  meta_json TEXT,
  UNIQUE (client_id, source, external_id)
);

CREATE TABLE source_state (
  client_id TEXT NOT NULL,
  source TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  PRIMARY KEY (client_id, source, key)
) WITHOUT ROWID;

CREATE TABLE runs (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  client_id TEXT NOT NULL,
  target_date TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'ok', 'error')),
  error TEXT
);
CREATE INDEX runs_last_ok ON runs (client_id, source, status, finished_at);

CREATE TABLE reports (
  client_id TEXT NOT NULL,
  month TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'sent')),
  ai_status TEXT,
  url TEXT,
  sent_at TEXT,
  PRIMARY KEY (client_id, month)
) WITHOUT ROWID;
