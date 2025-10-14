// src/jobs/poll_aid.ts
import { Client, Guild, TextChannel } from "discord.js";
import { query } from "../data/db.js";
import { getGuildSettings } from "../data/settings.js";
import { fetchAidSince, fetchPriceMap, AidLikeEvent } from "../pnw/client.js";
import { fetchNationMap } from "../pnw/nations.js";
import { depositAlertEmbed } from "../ui/embeds.js";
import { bankRowWithWatch } from "../ui/radar.js";
import { watchersForNation } from "../data/watch.js";

// Optional: only used if available in your repo
let rangeStatus: ((aScore: number, tScore: number, nearPct: number) => { inRange: boolean; nearRange: boolean }) | null = null;
try {
  // @ts-ignore – best-effort import; ignore if missing
  const mod = await import("../logic/war_range.js");
  rangeStatus = mod.rangeStatus || null;
} catch { /* not fatal */ }

const RESOURCE_KEYS = ["food","munitions","steel","oil","aluminum","uranium","gasoline","coal","iron","bauxite","lead"] as const;

export function startAidPoller(client: Client) {
  const loop = async () => {
    try {
      await runOnce(client);
    } catch (e) {
      console.error("Aid poller error:", e);
    }
  };
  loop();
  setInterval(loop, Number(process.env.AID_POLL_MS ?? 90_000));
}

async function ensureTextChannel(client: Client, guild: Guild, wantedId?: string | null, fallbackName = "bank-radar"): Promise<TextChannel | null> {
  if (wantedId) {
    const c = guild.channels.cache.get(wantedId) || await guild.channels.fetch(wantedId).catch(() => null);
    if (c && c.isTextBased() && (c as TextChannel).send) return c as TextChannel;
  }
  const found = guild.channels.cache.find(ch => ch.isTextBased() && ch.name === fallbackName);
  if (found && (found as TextChannel).send) return found as TextChannel;
  return guild.channels.create({
    name: fallbackName,
    reason: "PNW bank radar",
  }).catch(() => null) as Promise<TextChannel | null>;
}

function computeNotionalUSD(ev: AidLikeEvent, priceMap: Record<string, number>): number {
  let total = Number(ev.cash ?? 0);
  for (const k of RESOURCE_KEYS) {
    // @ts-ignore
    const qty = Number(ev[k] ?? 0);
    if (!qty) continue;
    const p = Number(priceMap[k] ?? 0);
    total += qty * p;
  }
  return total;
}

function buildBreakdown(ev: AidLikeEvent): string {
  const parts: string[] = [];
  if (ev.cash) parts.push(`$${fmt(ev.cash)} cash`);
  const add = (k: keyof AidLikeEvent, label?: string) => {
    // @ts-ignore
    const v = Number(ev[k] ?? 0);
    if (v) parts.push(`${fmt(v)} ${label || String(k)}`);
  };
  add("food");
  add("munitions");
  add("steel");
  add("oil");
  add("aluminum");
  add("uranium");
  add("gasoline");
  add("coal");
  add("iron");
  add("bauxite");
  add("lead");
  return parts.join(", ");
}

function fmt(n: number): string {
  return Number(n).toLocaleString("en-US");
}
function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

async function runOnce(client: Client) {
  // single-guild mode (same as your current behavior)
  const guildId = (process.env.ALLOWED_GUILDS || "").split(",").map(s => s.trim()).filter(Boolean)[0];
  if (!guildId) return;

  const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return;

  const gs: any = await getGuildSettings(guildId);
  if (!gs?.alerts_enabled || !gs?.deposits_enabled) return;

  // cursor
  const cur = await query("SELECT last_aid_id, last_seen_at FROM aid_cursor WHERE id=1");
  const lastAidId: number | undefined = cur.rows[0]?.last_aid_id ?? undefined;
  const lastSeenIso: string | undefined = cur.rows[0]?.last_seen_at ?? undefined;

  // fetch recent bankrecs mapped to aid-like events
  const aid = await fetchAidSince(lastAidId, lastSeenIso);
  if (!aid.length) return;

  // price map
  const prices = await fetchPriceMap();

  // linked raider nations (for in/near-range routing if needed)
  const raiders = await query("SELECT discord_user_id, nation_id FROM user_nation WHERE is_primary=true");
  const raiderIds = raiders.rows.map((r: any) => Number(r.nation_id)).filter(Number.isFinite);

  // channel
  const bankChannel = await ensureTextChannel(client, guild, gs.deposits_channel_id, "bank-radar");

  // process oldest → newest
  const ordered = [...aid].sort((a, b) => a.id - b.id);
  let newestId = lastAidId ?? 0;
  let newestTs = lastSeenIso;

  for (const ev of ordered) {
    newestId = Math.max(newestId, ev.id);
    newestTs = ev.sentAt;

    const notional = computeNotionalUSD(ev, prices);
    const floorAbs = Number(gs.deposit_threshold_abs_usd ?? 0);
    if (notional < floorAbs) continue;

    // dedupe by id+receiver+rounded
    const hash = `bank-${ev.id}-${ev.receiverId}-${Math.round(notional)}`;
    const { rows: existing } = await query("SELECT 1 FROM alert_log WHERE message_hash=$1", [hash]);
    if (existing.length) continue;

    // in/near-range gate (guild-wide)
    let anyInRange = true;
    if (gs.inrange_only && rangeStatus) {
      // need target + attacker scores
      const nationMap = await fetchNationMap([ev.receiverId, ...raiderIds]);
      const target = nationMap[ev.receiverId];
      if (!target || typeof target.score !== "number") continue;
      const tScore = target.score;
      const nearPct = Number(gs.near_range_pct ?? 5);
      anyInRange = raiderIds.some(rid => {
        const rn = nationMap[rid];
        if (!rn || typeof rn.score !== "number") return false;
        const s = rangeStatus!(rn.score, tScore, nearPct);
        return s.inRange || s.nearRange;
      });
      if (!anyInRange) continue;
    }

    // Build embed payload (and 🔔 button)
    const payload = depositAlertEmbed({
      nationId: ev.receiverId,
      nationName: ev.receiverName || `#${ev.receiverId}`,
      senderId: ev.senderId,
      senderName: ev.senderName,
      notionalUSD: Math.round(notional),
      breakdown: buildBreakdown(ev),
      whenText: timeAgo(ev.sentAt)
    });
    const components = [...(payload.components ?? [])];
    components.push(bankRowWithWatch(ev.receiverId));

    if (bankChannel) {
      await (bankChannel as TextChannel).send({
        ...payload,
        components,
        allowedMentions: { parse: [] }
      }).catch(() => null);
    }

    // DM watchers (respect per-user abs threshold + optional in/near filter)
    const watchers = await watchersForNation(ev.receiverId);
    if (watchers.length) {
      // prefetch target score only once if needed
      let targetScore: number | undefined;
      if (rangeStatus && (watchers.some((w: any) => w.inrange_only))) {
        const nationMap = await fetchNationMap([ev.receiverId, ...raiderIds]);
        targetScore = nationMap[ev.receiverId]?.score;
      }

      for (const w of watchers) {
        const member = await guild.members.fetch(w.discord_user_id).catch(() => null);
        const user = member?.user;
        if (!user) continue;

        const myFloor = Number(w.bank_abs_usd ?? floorAbs);
        if (notional < myFloor) continue;

        if (rangeStatus && w.inrange_only && typeof targetScore === "number") {
          // get their attacker score
          const myNation = await query(
            "SELECT nation_id FROM user_nation WHERE discord_user_id=$1 AND is_primary=true LIMIT 1",
            [w.discord_user_id]
          );
          const nid = Number(myNation.rows[0]?.nation_id ?? 0);
          if (!nid) continue;

          const nationMap = await fetchNationMap([nid, ev.receiverId]);
          const aScore = nationMap[nid]?.score;
          if (typeof aScore !== "number") continue;

          const s = rangeStatus(aScore, targetScore, Number(gs.near_range_pct ?? 5));
          if (!s.inRange && !s.nearRange) continue;
        }

        await user.send({
          ...payload,
          components,
          allowedMentions: { parse: [] }
        }).catch(() => null);

        await query(
          "INSERT INTO alert_log (event_type, nation_id, notional_value, message_hash) VALUES ($1,$2,$3,$4)",
          ["deposit_watch_dm", ev.receiverId, Math.round(notional), `${hash}-u${w.discord_user_id}`]
        );
      }
    }

    // record main log entry
    await query(
      "INSERT INTO alert_log (event_type, nation_id, notional_value, message_hash) VALUES ($1,$2,$3,$4)",
      ["deposit", ev.receiverId, Math.round(notional), hash]
    );
  }

  await query("UPDATE aid_cursor SET last_aid_id=$1, last_seen_at=$2 WHERE id=1", [newestId || null, newestTs || null]);
}
