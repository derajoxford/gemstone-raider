import "dotenv/config";
import { Pool } from "pg";
const url = process.env.DATABASE_URL; if (!url) { console.error("DATABASE_URL missing"); process.exit(1); }
const pool = new Pool({ connectionString: url });

const base = `
CREATE TABLE IF NOT EXISTS user_nation (
  discord_user_id TEXT NOT NULL,
  nation_id BIGINT NOT NULL,
  is_primary BOOLEAN NOT NULL DEFAULT TRUE,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (discord_user_id, nation_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS user_primary_unique ON user_nation (discord_user_id) WHERE is_primary;

CREATE TABLE IF NOT EXISTS guild_settings (
  guild_id TEXT PRIMARY KEY,
  deposits_channel_id TEXT,
  near_range_pct INTEGER NOT NULL DEFAULT 5,
  deposit_threshold_abs_usd BIGINT NOT NULL DEFAULT 2000000,
  deposit_threshold_rel_pct INTEGER NOT NULL DEFAULT 20,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

const alters = `
ALTER TABLE guild_settings
  ADD COLUMN IF NOT EXISTS alerts_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS deposits_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS alerts_dm BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS alerts_role_id TEXT;

-- keep updated_at fresh
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_touch_updated_at ON guild_settings;
CREATE TRIGGER trg_touch_updated_at BEFORE UPDATE ON guild_settings
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
`;

(async () => {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(base);
    await c.query(alters);

    const gid = (process.env.ALLOWED_GUILDS || "").split(",").map(s=>s.trim()).filter(Boolean)[0];
    if (gid) {
      await c.query(
        `INSERT INTO guild_settings (guild_id, deposits_channel_id, deposit_threshold_abs_usd, deposit_threshold_rel_pct, near_range_pct)
         VALUES ($1,$2,COALESCE($3::bigint,2000000),COALESCE($4::int,20),COALESCE($5::int,5))
         ON CONFLICT (guild_id) DO UPDATE SET
          deposits_channel_id=EXCLUDED.deposits_channel_id,
          deposit_threshold_abs_usd=EXCLUDED.deposit_threshold_abs_usd,
          deposit_threshold_rel_pct=EXCLUDED.deposit_threshold_rel_pct,
          near_range_pct=EXCLUDED.near_range_pct`,
        [gid, process.env.DEPOSITS_CHANNEL_ID ?? null, process.env.DEPOSIT_THRESHOLD_ABS_USD ?? null, process.env.DEPOSIT_THRESHOLD_REL_PCT ?? null, process.env.NEAR_RANGE_PCT ?? null]
      );
    }
    await c.query("COMMIT");
    console.log("✅ Migration complete");
  } catch (e) { await c.query("ROLLBACK"); console.error(e); process.exit(1); }
  finally { c.release(); await pool.end(); }
})();
