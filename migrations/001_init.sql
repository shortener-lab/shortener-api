CREATE TABLE links (
  code        text PRIMARY KEY,
  url         text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Idempotência do worker: um evento só é contado se o seu ID ainda não estiver aqui.
CREATE TABLE processed_events (
  event_id      uuid PRIMARY KEY,
  processed_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE click_stats_daily (
  code    text NOT NULL REFERENCES links (code),
  day     date NOT NULL,
  clicks  bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (code, day)
);

CREATE TABLE click_stats_browser (
  code     text NOT NULL REFERENCES links (code),
  browser  text NOT NULL,
  clicks   bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (code, browser)
);
