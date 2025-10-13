import type { Client } from "discord.js";
import { query } from "../data/db.js";
import { depositAlertEmbed } from "../ui/embeds.js";
import { every } from "../core/scheduler.js";

/**
 * Large Deposit detector (skeleton).
 * TODO: Replace the mock fetch with real PnW API calls and map into events.
 */
export function startAidPoller(client: Client) {
  const abs = Number(process.env.DEPOSIT_THRESHOLD_ABS_USD ?? 2000000);
  const rel = Number(process.env.DEPOSIT_THRESHOLD_REL_PCT ?? 20);

  // poll every 90s (adjust as needed)
  every(90_000, async () => {
    const guildCsv = process.env.ALLOWED_GUILDS || "";
    const guildId = guildCsv.split(",").map(s => s.trim()).filter(Boolean)[0];

    if (!guildId) return;

    const { rows } = await query<{ deposits_channel_id: string | null }>(
      `SELECT deposits_channel_id FROM guild_settings WHERE guild_id=$1`,
      [guildId]
    );
    const channelId = rows[0]?.deposits_channel_id || process.env.DEPOSITS_CHANNEL_ID;
    if (!channelId) return;

    // TODO: call PnW API here and compute "events" array.
    // For now, do nothing (no mock spam).
    // Example shape if you wire it:
    // const events = await fetchAidSince(lastTs)...
    const events: Array<{
      nationId: number; nationName: string;
      senderId?: number; senderName?: string;
      notionalUSD: number; breakdown: string; whenText: string;
      lootP50?: number;
    }> = [];

    // thresholding & post
    for (const ev of events) {
      const thresholdHit = ev.notionalUSD >= abs || (ev.lootP50 && ev.notionalUSD >= (ev.lootP50 * rel / 100));
      if (!thresholdHit) continue;
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel || !("send" in channel)) continue;
      // @ts-ignore - runtime check done
      await channel.send(depositAlertEmbed(ev));
    }
  });
}
