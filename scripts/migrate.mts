import "dotenv/config";
import { Pool } from "pg";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL missing"); process.exit(1); }
const pool = new Pool({ connectionString: url });

const createBase = `
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
  event_type TEXT NOT NULL,
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
`;

const alterGuildSettings = `
ALTER TABLE guild_settings
  ADD COLUMN IF NOT EXISTS deposits_channel_id TEXT,
  ADD COLUMN IF NOT EXISTS near_range_pct INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS deposit_threshold_abs_usd BIGINT NOT NULL DEFAULT 2000000,
  ADD COLUMN IF NOT EXISTS deposit_threshold_rel_pct INTEGER NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS alerts_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS deposits_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS alerts_dm BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS alerts_role_id TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_touch_updated_at ON guild_settings;
CREATE TRIGGER trg_touch_updated_at
  BEFORE UPDATE ON guild_settings
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
`;

(async () => {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");

    // Ensure tables exist
    await c.query(createBase);

    // Ensure all columns exist
    await c.query(alterGuildSettings);

    // Seed default guild row from env (does not overwrite unless missing)
    const gid = (process.env.ALLOWED_GUILDS || "")
      .split(",").map(s => s.trim()).filter(Boolean)[0];

    if (gid) {
      await c.query(
        `INSERT INTO guild_settings (guild_id) VALUES ($1)
         ON CONFLICT (guild_id) DO NOTHING`,
        [gid]
      );

      // Apply env defaults if provided
      await c.query(
        `UPDATE guild_settings
           SET deposits_channel_id = COALESCE($2, deposits_channel_id),
               deposit_threshold_abs_usd = COALESCE($3::bigint, deposit_threshold_abs_usd),
               deposit_threshold_rel_pct = COALESCE($4::int, deposit_threshold_rel_pct),
               near_range_pct = COALESCE($5::int, near_range_pct)
         WHERE guild_id = $1`,
        [
          gid,
          process.env.DEPOSITS_CHANNEL_ID ?? null,
          process.env.DEPOSIT_THRESHOLD_ABS_USD ?? null,
          process.env.DEPOSIT_THRESHOLD_REL_PCT ?? null,
          process.env.NEAR_RANGE_PCT ?? null
        ]
      );
    }

    // Ensure cursor row exists
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
    c.release();
    await pool.end();
  }
})();
