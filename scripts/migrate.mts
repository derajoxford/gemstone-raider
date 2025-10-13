import "dotenv/config";
import { Pool } from "pg";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL missing"); process.exit(1); }
const pool = new Pool({ connectionString: url });

const base = `
CREATE TABLE IF NOT EXISTS user_nation (
  discord_user_id TEXT NOT NULL,
  nation_id BIGINT NOT NULL,
  is_primary BOOLEAN NOT NULL DEFAULT TRUE,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (discord_user_id, nation_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS user_primary_unique
  ON user_nation (discord_user_id) WHERE is_primary;

CREATE TABLE IF NOT EXISTS guild_settings (
  guild_id TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS alert_log (
  id BIGSERIAL PRIMARY KEY,
  event_type TEXT NOT NULL,          -- 'deposit' | 'beige_soon' | 'slot_open' | 'deposit_watch_dm'
  nation_id BIGINT,
  notional_value BIGINT,
  message_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS aid_cursor (
  id INTEGER PRIMARY KEY DEFAULT 1,
  last_aid_id BIGINT,
  last_seen_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS price_cache (
  resource TEXT PRIMARY KEY,
  usd NUMERIC NOT NULL,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- per-user watch entries
CREATE TABLE IF NOT EXISTS watchlist (
  discord_user_id TEXT NOT NULL,
  nation_id BIGINT NOT NULL,
  dm_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  bank_abs_usd BIGINT,                -- per-nation floor for this user (nullable = use guild default)
  bank_rel_pct INTEGER,               -- used by heat v1 later
  beige_early_min INTEGER,            -- minutes before beige exit to DM
  inrange_only BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (discord_user_id, nation_id)
);
`;

const alterGuild = `
ALTER TABLE guild_settings
  ADD COLUMN IF NOT EXISTS deposits_channel_id TEXT,           -- legacy (kept)
  ADD COLUMN IF NOT EXISTS near_range_pct INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS deposit_threshold_abs_usd BIGINT NOT NULL DEFAULT 2000000, -- legacy
  ADD COLUMN IF NOT EXISTS deposit_threshold_rel_pct INTEGER NOT NULL DEFAULT 20,     -- legacy
  ADD COLUMN IF NOT EXISTS alerts_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS deposits_enabled BOOLEAN NOT NULL DEFAULT true,            -- legacy
  ADD COLUMN IF NOT EXISTS alerts_dm BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS alerts_role_id TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- new radar controls
  ADD COLUMN IF NOT EXISTS bank_radar_channel_id TEXT,
  ADD COLUMN IF NOT EXISTS beige_radar_channel_id TEXT,
  ADD COLUMN IF NOT EXISTS bank_abs_usd BIGINT NOT NULL DEFAULT 10000000,
  ADD COLUMN IF NOT EXISTS bank_rel_pct INTEGER NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS radar_poll_ms INTEGER NOT NULL DEFAULT 90000,
  ADD COLUMN IF NOT EXISTS dm_default BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS inrange_only BOOLEAN NOT NULL DEFAULT FALSE
;

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_touch_updated_at ON guild_settings;
CREATE TRIGGER trg_touch_updated_at
  BEFORE UPDATE ON guild_settings
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- small helper to auto-vacuum old alert logs if desired (noop now)
`;

(async () => {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(base);
    await c.query(alterGuild);

    const gid = (process.env.ALLOWED_GUILDS || "").split(",").map(s=>s.trim()).filter(Boolean)[0];
    if (gid) {
      await c.query(`INSERT INTO guild_settings (guild_id) VALUES ($1) ON CONFLICT (guild_id) DO NOTHING`, [gid]);
      // Seed some defaults from env if provided
      await c.query(
        `UPDATE guild_settings
           SET bank_radar_channel_id = COALESCE($2, bank_radar_channel_id),
               beige_radar_channel_id = COALESCE($3, beige_radar_channel_id),
               bank_abs_usd = COALESCE(NULLIF($4,'')::bigint, bank_abs_usd),
               bank_rel_pct = COALESCE(NULLIF($5,'')::int, bank_rel_pct),
               near_range_pct = COALESCE(NULLIF($6,'')::int, near_range_pct)
         WHERE guild_id=$1`,
        [
          gid,
          process.env.BANK_RADAR_CHANNEL_ID ?? null,
          process.env.BEIGE_RADAR_CHANNEL_ID ?? null,
          process.env.BANK_ABS_USD ?? null,
          process.env.BANK_REL_PCT ?? null,
          process.env.NEAR_RANGE_PCT ?? null
        ]
      );
    }

    await c.query(
      `INSERT INTO aid_cursor (id, last_aid_id, last_seen_at)
       VALUES (1, NULL, NULL)
       ON CONFLICT (id) DO NOTHING`
    );

    await c.query("COMMIT");
    console.log("✅ Migration complete");
  } catch (e) {
    await c.query("ROLLBACK");
    console.error(e);
    process.exit(1);
  } finally {
    c.release(); await pool.end();
  }
})();
