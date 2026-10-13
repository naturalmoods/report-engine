CREATE TABLE uptime_checks (
  id INTEGER PRIMARY KEY,
  client_id TEXT NOT NULL,
  url TEXT NOT NULL,
  ts TEXT NOT NULL,           -- UTC ISO
  ok INTEGER NOT NULL,
  status INTEGER,
  response_ms INTEGER,
  error TEXT
);
CREATE INDEX uptime_checks_client_ts ON uptime_checks (client_id, ts);
