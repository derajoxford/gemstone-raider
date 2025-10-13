import { query } from "./db.js";

export type GuildSettings = {
  guild_id: string;
  deposits_channel_id: string | null;
  near_range_pct: number;
  deposit_threshold_abs_usd: number;
  deposit_threshold_rel_pct: number;
  alerts_enabled: boolean;
  deposits_enabled: boolean;
  alerts_dm: boolean;
  alerts_role_id: string | null;
};

export async function getGuildSettings(guildId: string): Promise<GuildSettings> {
  const { rows } = await query<GuildSettings>(
    `SELECT guild_id, deposits_channel_id, near_range_pct,
            deposit_threshold_abs_usd, deposit_threshold_rel_pct,
            alerts_enabled, deposits_enabled, alerts_dm, alerts_role_id
     FROM guild_settings WHERE guild_id=$1`, [guildId]
  );
  const row = rows[0];
  return row ?? {
    guild_id: guildId,
    deposits_channel_id: null,
    near_range_pct: Number(process.env.NEAR_RANGE_PCT ?? 5),
    deposit_threshold_abs_usd: Number(process.env.DEPOSIT_THRESHOLD_ABS_USD ?? 2000000),
    deposit_threshold_rel_pct: Number(process.env.DEPOSIT_THRESHOLD_REL_PCT ?? 20),
    alerts_enabled: true,
    deposits_enabled: true,
    alerts_dm: false,
    alerts_role_id: null
  };
}
