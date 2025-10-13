import "dotenv/config";
import { Pool } from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL missing");
  process.exit(1);
}
const pool = new Pool({ connectionString: url });

const sql = `
CREATE TABLE IF NOT EXISTS user_nation (
  discord_user_id TEXT NOT NULL,
  nation_id BIGINT NOT NULL,
  is_primary BOOLEAN NOT NULL DEFAULT TRUE,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (discord_user_id, nation_id)
);

-- Only one primary per user (soft constraint; keep app logic too)
CREATE UNIQUE INDEX IF NOT EXISTS user_primary_unique
ON user_nation (discord_user_id)
WHERE is_primary;

CREATE TABLE IF NOT EXISTS guild_settings (
  guild_id TEXT PRIMARY KEY,
  deposits_channel_id TEXT,
  near_range_pct INTEGER NOT NULL DEFAULT 5,
  deposit_threshold_abs_usd BIGINT NOT NULL DEFAULT 2000000,
  deposit_threshold_rel_pct INTEGER NOT NULL DEFAULT 20,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS alert_log (
  id BIGSERIAL PRIMARY KEY,
  event_type TEXT NOT NULL,               -- e.g., 'deposit'
  nation_id BIGINT,
  notional_value BIGINT,
  message_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

(async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    // seed defaults from env if present
    const gid = process.env.ALLOWED_GUILDS?.split(",").map(s => s.trim()).filter(Boolean)[0];
    const depositsChannel = process.env.DEPOSITS_CHANNEL_ID;
    const absStr = process.env.DEPOSIT_THRESHOLD_ABS_USD;
    const relStr = process.env.DEPOSIT_THRESHOLD_REL_PCT;
    const nearStr = process.env.NEAR_RANGE_PCT;

    if (gid) {
      await client.query(
        `INSERT INTO guild_settings (guild_id, deposits_channel_id, deposit_threshold_abs_usd, deposit_threshold_rel_pct, near_range_pct)
         VALUES ($1,$2,COALESCE($3::bigint, 2000000),COALESCE($4::int,20),COALESCE($5::int,5))
         ON CONFLICT (guild_id) DO UPDATE SET
          deposits_channel_id = EXCLUDED.deposits_channel_id,
          deposit_threshold_abs_usd = EXCLUDED.deposit_threshold_abs_usd,
          deposit_threshold_rel_pct = EXCLUDED.deposit_threshold_rel_pct,
          near_range_pct = EXCLUDED.near_range_pct,
          updated_at = now()`,
        [gid, depositsChannel ?? null, absStr ?? null, relStr ?? null, nearStr ?? null]
      );
    }
    await client.query("COMMIT");
    console.log("✅ Migration complete");
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
})();
