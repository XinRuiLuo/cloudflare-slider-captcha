-- cloudflare-slider-captcha · D1 schema
-- 远端初始化：npx wrangler d1 execute captcha-db --remote --file=./schema.sql
-- 本地初始化：npx wrangler d1 execute captcha-db --local  --file=./schema.sql
--
-- 说明：服务端首次访问 /api/captcha/* 时也会自动建表（见 src/captcha.js 的
-- ensureCaptchaSchema），此文件用于提前初始化或手工检查，二者等价。

CREATE TABLE IF NOT EXISTS captcha_challenges (
  id TEXT PRIMARY KEY,
  answer INTEGER NOT NULL,
  piece_y INTEGER NOT NULL,
  piece_w INTEGER NOT NULL,
  piece_h INTEGER NOT NULL,
  pieces TEXT,                                  -- JSON: { slots: [...], correctIndex }
  ip TEXT NOT NULL DEFAULT '',
  device TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  solved INTEGER NOT NULL DEFAULT 0 CHECK(solved IN (0, 1)),
  ticket TEXT,                                  -- 通过后签发的一次性票据
  ticket_used INTEGER NOT NULL DEFAULT 0 CHECK(ticket_used IN (0, 1)),
  solved_at TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_captcha_ticket ON captcha_challenges(ticket);
CREATE INDEX IF NOT EXISTS idx_captcha_expires ON captcha_challenges(expires_at);
CREATE INDEX IF NOT EXISTS idx_captcha_ip_created ON captcha_challenges(ip, created_at);