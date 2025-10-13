import { query } from "./db.js";

export type GuildSettings = {
  guild_id: string;
  // legacy
  deposits_channel_id: string | null;
  deposit_threshold_abs_usd: number;
  deposit_threshold_rel_pct: number;
  deposits_enabled: boolean;

  // shared
  near_range_pct: number;
  alerts_enabled: boolean;
  alerts_dm: boolean;
  alerts_role_id: string | null;

  // radar
  bank_radar_channel_id: string | null;
  beige_radar_channel_id: string | null;
  bank_abs_usd: number;
  bank_rel_pct: number;
  radar_poll_ms: number;
  dm_default: boolean;
  inrange_only: boolean;
};

export async function getGuildSettings(guildId: string): Promise<GuildSettings> {
  const { rows } = await query<GuildSettings>(
    `SELECT guild_id,
            deposits_channel_id, deposit_threshold_abs_usd, deposit_threshold_rel_pct, deposits_enabled,
            near_range_pct, alerts_enabled, alerts_dm, alerts_role_id,
            bank_radar_channel_id, beige_radar_channel_id, bank_abs_usd, bank_rel_pct, radar_poll_ms, dm_default, inrange_only
     FROM guild_settings WHERE guild_id=$1`,
    [guildId]
  );

  const r = rows[0];
  return r ?? {
    guild_id: guildId,
    deposits_channel_id: null,
    deposit_threshold_abs_usd: 2_000_000,
    deposit_threshold_rel_pct: 20,
    deposits_enabled: true,
    near_range_pct: Number(process.env.NEAR_RANGE_PCT ?? 5),
    alerts_enabled: true,
    alerts_dm: false,
    alerts_role_id: null,
    bank_radar_channel_id: null,
    beige_radar_channel_id: null,
    bank_abs_usd: Number(process.env.BANK_ABS_USD ?? 10_000_000),
    bank_rel_pct: Number(process.env.BANK_REL_PCT ?? 20),
    radar_poll_ms: Number(process.env.RADAR_POLL_MS ?? 90_000),
    dm_default: true,
    inrange_only: false
  };
}
