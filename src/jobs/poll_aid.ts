// src/jobs/poll_aid.ts
// Global Bank Radar — scans ALL aid (nation→nation + alliance→nation) and alerts on large deposits.
// Safe with only GatewayIntentBits.Guilds; no member fetch.
// Cadence taken from env with jitter + simple quiet backoff.
// Posts to each guild’s configured alerts channel and DMs watchers of the receiver nation.

import type { Client, TextBasedChannel } from "discord.js";
import { EmbedBuilder } from "discord.js";
import { query } from "../data/db.js";
import { getGuildSettings } from "../data/settings.js";
import { fetchAidSince, fetchPriceMap } from "../pnw/client.js";

const ms = (n: number) => Math.max(0, Math.floor(n));
const nowSec = () => Math.floor(Date.now() / 1000);
const withJitter = (baseMs: number, jitterMs: number) =>
  ms(baseMs + (Math.random() * 2 - 1) * jitterMs);

// env knobs (fallbacks match /etc/pnw-raider.env)
const POLL_SEC = Number(process.env.DEPOSITS_POLL_SEC || "15");
const POLL_MIN_SEC = Number(process.env.DEPOSITS_POLL_MIN_SEC || "10");
const POLL_MAX_SEC = Number(process.env.DEPOSITS_POLL_MAX_SEC || "45");
const POLL_JITTER_SEC = Number(process.env.DEPOSITS_POLL_JITTER_SEC || "3");
const QUIET_BACKOFF_SEC = Number(process.env.DEPOSITS_BACKOFF_AFTER_QUIET_SEC || "120");
const BURST_TIGHTEN_COUNT = Number(process.env.DEPOSITS_BURST_TIGHTEN_COUNT || "10");
const BURST_WINDOW_SEC = Number(process.env.DEPOSITS_BURST_WINDOW_SEC || "60");

// thresholds
const ABS_USD_DEFAULT = Number(process.env.DEPOSIT_THRESHOLD_ABS_USD || "100000000");
const REL_PCT_DEFAULT = Number(process.env.DEPOSIT_THRESHOLD_REL_PCT || "20");
// Optional: if set, REL threshold is LOOT_P50_USD * relPct / 100
const LOOT_P50_USD = Number(process.env.LOOT_P50_USD || "0");

type AidRow = {
  id: number;
  sender_type: "NATION" | "ALLIANCE";
  sender_id: number;
  receiver_type: "NATION" | "ALLIANCE";
  receiver_id: number;
  cash: number;
  resources?: Record<string, number> | null;
  created_at: string; // ISO
};

async function valueUSD(resources: Record<string, number> | null | undefined, cash: number): Promise<number> {
  let total = Number(cash || 0);
  const price = await fetchPriceMap(); // { resource: priceUSD }
  if (resources) {
    for (const [k, v] of Object.entries(resources)) {
      const qty = Number(v || 0);
      const p = Number((price as any)[k] || 0);
      if (!Number.isFinite(qty) || qty <= 0) continue;
      total += qty * p;
    }
  }
  return Math.max(0, Math.floor(total));
}

function passThreshold(amountUSD: number, absGuild?: number, relGuildPct?: number): boolean {
  const abs = Number.isFinite(absGuild) && (absGuild as number) > 0 ? (absGuild as number) : ABS_USD_DEFAULT;
  const relPct = Number.isFinite(relGuildPct) && (relGuildPct as number) > 0 ? (relGuildPct as number) : REL_PCT_DEFAULT;
  if (amountUSD >= abs) return true;
  if (LOOT_P50_USD > 0 && amountUSD >= (LOOT_P50_USD * relPct) / 100) return true;
  return false;
}

function formatUSD(n: number) {
  return `$${n.toLocaleString("en-US")}`;
}

function nationLink(id: number) {
  return `https://politicsandwar.com/nation/id=${id}`;
}
function allianceLink(id: number) {
  return `https://politicsandwar.com/alliance/id=${id}`;
}

export function startAidPoller(client: Client) {
  let lastSeenId = 0;
  let lastHitTs = 0;
  const hitTimestamps: number[] = [];

  const baseMs = ms(POLL_SEC * 1000);
  const minMs = ms(POLL_MIN_SEC * 1000);
  const maxMs = ms(POLL_MAX_SEC * 1000);
  const jitterMs = ms(POLL_JITTER_SEC * 1000);

  let dynamicMs = baseMs;             // <-- only declared here
  let timer: NodeJS.Timeout | null = null;

  const scheduleNext = () => {
    // quiet backoff (no hits for a while)
    if (lastHitTs && nowSec() - lastHitTs >= QUIET_BACKOFF_SEC) {
      dynamicMs = Math.min(maxMs, Math.max(dynamicMs, baseMs * 2));
    }

    // burst tighten (lots of hits recently)
    const cutoff = nowSec() - BURST_WINDOW_SEC;
    while (hitTimestamps.length && hitTimestamps[0] < cutoff) hitTimestamps.shift();
    if (hitTimestamps.length >= BURST_TIGHTEN_COUNT) {
      dynamicMs = Math.max(minMs, Math.floor(baseMs * 0.66));
    }

    const wait = withJitter(dynamicMs, Math.min(jitterMs, Math.floor(dynamicMs * 0.2)));
    timer = setTimeout(tick, wait);
  };

  const tick = async () => {
    try {
      const rows: AidRow[] = (await fetchAidSince(lastSeenId || undefined)) as any;

      // Prime on first run to avoid historical spam
      if (lastSeenId === 0) {
        let maxId = 0;
        for (const r of rows) maxId = Math.max(maxId, Number(r.id || 0));
        lastSeenId = maxId;
        console.log(`Bank radar primed at id=${lastSeenId}`);
        return scheduleNext();
      }

      // Only deposits into nations (captures nation→nation and alliance→nation)
      const hits = rows.filter((r) => r && r.receiver_type === "NATION");

      let newMax = lastSeenId;
      let postedCount = 0;

      // Preload guild settings
      const guilds = [...client.guilds.cache.values()];
      const settingsByGuild: Record<string, Awaited<ReturnType<typeof getGuildSettings>>> = {};
      for (const g of guilds) {
        try { settingsByGuild[g.id] = await getGuildSettings(g.id); } catch {}
      }

      for (const r of hits) {
        newMax = Math.max(newMax, Number(r.id || 0));

        const amountUSD = await valueUSD(r.resources || null, r.cash || 0);

        for (const g of guilds) {
          const gs = settingsByGuild[g.id];
          if (!gs) continue;

          const chanId = gs.alerts_channel_id || gs.deposits_channel_id || gs.alerts_channel || gs.channel_id;
          if (!chanId) continue;

          const absGuild = Number(gs.deposit_abs_usd || gs.deposit_abs || gs.deposit_threshold_abs_usd || 0);
          const relGuild = Number(gs.deposit_rel_pct || gs.deposit_threshold_rel_pct || 0);
          if (!passThreshold(amountUSD, absGuild, relGuild)) continue;

          const senderIsAlliance = r.sender_type === "ALLIANCE";
          const senderUrl = senderIsAlliance ? allianceLink(r.sender_id) : nationLink(r.sender_id);
          const receiverUrl = nationLink(r.receiver_id);

          const embed = new EmbedBuilder()
            .setColor(0x00e676)
            .setTitle("💰 Large Deposit Detected")
            .setDescription(
              `${senderIsAlliance ? "Alliance" : "Nation"} → Nation transfer\n` +
              `**Amount:** ${formatUSD(amountUSD)}\n` +
              `**From:** ${senderIsAlliance ? `[Alliance #${r.sender_id}](${senderUrl})` : `[Nation #${r.sender_id}](${senderUrl})`}\n` +
              `**To:** [Nation #${r.receiver_id}](${receiverUrl})`
            )
            .setFooter({ text: `Aid ID ${r.id} • Bank Radar` })
            .setTimestamp(new Date(r.created_at || Date.now()));

          const mention = gs.alerts_mention_role_id ? `<@&${gs.alerts_mention_role_id}> ` : "";

          try {
            const channel = (await client.channels.fetch(chanId).catch(() => null)) as TextBasedChannel | null;
            if (channel && "send" in channel && typeof (channel as any).send === "function") {
              await (channel as any).send({ content: mention || undefined, embeds: [embed] });
              postedCount++;
            }
          } catch (e) {
            console.error("Bank radar channel send error:", e);
          }

          // DM watchers of the RECEIVER nation (opt-in)
          try {
            const { rows: watchers } = await query<{
              discord_user_id: string;
              dm_enabled: boolean;
            }>(
              "select discord_user_id, dm_enabled from watchlist where nation_id=$1 and (dm_enabled is true)",
              [r.receiver_id]
            );

            for (const w of watchers) {
              try {
                const u = await client.users.fetch(w.discord_user_id);
                await u.send({ embeds: [embed] });
              } catch {
                // ignore DM failures
              }
            }
          } catch (e) {
            console.error("Bank radar DM error:", e);
          }
        }
      }

      if (newMax > lastSeenId) {
        lastSeenId = newMax;
        lastHitTs = nowSec();
        hitTimestamps.push(lastHitTs);
      }

      console.log(
        `Bank radar tick — new=${postedCount} lastSeenId=${lastSeenId} interval=${Math.round(dynamicMs / 1000)}s`
      );
    } catch (e) {
      console.error("Bank radar error:", e);
    } finally {
      scheduleNext();
    }
  };

  // initial schedule
  scheduleNext();

  // graceful stop
  const stop = () => { if (timer) clearTimeout(timer); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
