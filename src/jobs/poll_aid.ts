import type { Client, Guild } from "discord.js";
import { query } from "../data/db.js";
import { getGuildSettings } from "../data/settings.js";
import { fetchAidSince, fetchPriceMap } from "../pnw/client.js";
import { fetchNationMap } from "../pnw/nations.js";
import { depositAlertEmbed } from "../ui/embeds.js";

const POLL_MS = Number(process.env.AID_POLL_MS ?? 90_000);
// Score declare window (Aug 2023): 75%..250%
const DECL_MIN = 0.75;
const DECL_MAX = 2.50;

export function startAidPoller(client: Client) {
  let ticking = false;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try { await runOnce(client); } catch (e) { console.error("Aid poller error:", e); }
    finally { ticking = false; }
  };
  tick();
  setInterval(tick, POLL_MS);
}

async function runOnce(client: Client) {
  const guildId = (process.env.ALLOWED_GUILDS || "").split(",").map(s=>s.trim()).filter(Boolean)[0];
  if (!guildId) return;

  const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return;

  const gs = await getGuildSettings(guildId);
  if (!gs.alerts_enabled || !gs.deposits_enabled) return;

  // cursor
  const cur = await query<{ last_aid_id: number | null, last_seen_at: string | null }>(
    "SELECT last_aid_id, last_seen_at FROM aid_cursor WHERE id=1"
  );
  const lastAidId = cur.rows[0]?.last_aid_id ?? undefined;
  const lastSeenIso = cur.rows[0]?.last_seen_at ?? undefined;

  // new aid (receiver is the target)
  const aid = await fetchAidSince(lastAidId, lastSeenIso);
  if (!aid.length) return;

  const prices = await fetchPriceMap();
  const abs = gs.deposit_threshold_abs_usd ?? Number(process.env.DEPOSIT_THRESHOLD_ABS_USD ?? 2_000_000);

  // alert channel
  const channelId = gs.deposits_channel_id || process.env.DEPOSITS_CHANNEL_ID || null;
  if (!channelId) return;
  const ch = await client.channels.fetch(channelId).catch(() => null);
  if (!ch || typeof (ch as any).send !== "function") return; // safe narrow
  const channel = ch as any;

  // Linked raiders (primary nation)
  const raiders = await query<{ discord_user_id: string; nation_id: number }>(
    "SELECT discord_user_id, nation_id FROM user_nation WHERE is_primary=true"
  );
  const raiderNationIds = raiders.rows.map(r => Number(r.nation_id)).filter(n => Number.isFinite(n));

  // chronological
  const ordered = [...aid].sort((a, b) => a.id - b.id);

  let newestId = lastAidId ?? 0;
  let newestTs: string | undefined = lastSeenIso;

  for (const ev of ordered) {
    const notional = computeNotionalUSD(ev as any, prices);
    newestId = Math.max(newestId, ev.id);
    newestTs = ev.sentAt;

    if (notional < abs) continue;

    // dedupe
    const hash = `${ev.id}-${ev.receiverId}-${Math.round(notional)}`;
    const { rows: existing } = await query("SELECT 1 FROM alert_log WHERE message_hash=$1", [hash]);
    if (existing.length) continue;

    // nation scores (target + raiders)
    const nationMap = await fetchNationMap([ev.receiverId, ...raiderNationIds]);
    const target = nationMap[ev.receiverId];

    // who to DM (in-range / near-range)
    let dmUsers: string[] = [];
    if (gs.alerts_dm && target) {
      for (const r of raiders.rows) {
        const rn = nationMap[r.nation_id];
        if (!rn || !Number.isFinite(rn.score)) continue;
        const status = rangeStatus(rn.score, target.score, gs.near_range_pct ?? 5);
        if (status.inRange || status.nearRange) dmUsers.push(r.discord_user_id);
      }
    }

    // channel post
    const payload = depositAlertEmbed({
      nationId: ev.receiverId,
      nationName: ev.receiverName,
      senderId: ev.senderId ?? undefined,
      senderName: ev.senderName ?? undefined,
      notionalUSD: Math.round(notional),
      breakdown: buildBreakdown(ev as any),
      whenText: timeAgo(ev.sentAt)
    });

    const mention = gs.alerts_role_id ? `<@&${gs.alerts_role_id}> ` : undefined;

    await channel.send({
      content: mention,
      ...(payload as any),
      allowedMentions: { parse: [], roles: gs.alerts_role_id ? [gs.alerts_role_id] : [] }
    });

    // DM raiders
    if (dmUsers.length) {
      await dmLinkedRaiders(guild, dmUsers, {
        ...(payload as any),
        allowedMentions: { parse: [] }
      }).catch(() => {});
    }

    await query(
      "INSERT INTO alert_log (event_type, nation_id, notional_value, message_hash) VALUES ($1,$2,$3,$4)",
      ["deposit", ev.receiverId, Math.round(notional), hash]
    );
  }

  // update cursor
  await query(
    "UPDATE aid_cursor SET last_aid_id=$1, last_seen_at=$2 WHERE id=1",
    [newestId || null, newestTs || null]
  );
}

// ---------- helpers ----------
async function dmLinkedRaiders(guild: Guild, userIds: string[], message: any) {
  for (const uid of userIds) {
    const m = await guild.members.fetch(uid).catch(() => null);
    const u = m?.user;
    if (!u) continue;
    await u.send(message).catch(() => {});
  }
}

function computeNotionalUSD(ev: any, priceMap: Record<string, number>) {
  let total = Number(ev.cash ?? 0);
  const resources: string[] = [
    "food","munitions","steel","oil","aluminum","uranium","gasoline","coal","iron","bauxite"
  ];
  for (const r of resources) {
    const qty = Number(ev[r] ?? 0);
    if (!qty) continue;
    const p = Number(priceMap[r] ?? 0);
    if (!p) continue;
    total += qty * p;
  }
  return total;
}

function buildBreakdown(ev: any) {
  const parts: string[] = [];
  if (ev.cash) parts.push(`$${fmt(ev.cash)} cash`);
  const add = (k: string, label?: string) => {
    const v = Number(ev[k] ?? 0);
    if (v) parts.push(fmt(v) + " " + (label || k));
  };
  add("food"); add("munitions"); add("steel"); add("oil"); add("aluminum"); add("uranium");
  add("gasoline"); add("coal"); add("iron"); add("bauxite");
  return parts.join(" • ");
}

function fmt(n: number) { return Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n); }
function timeAgo(iso: string) {
  const then = new Date(iso).getTime();
  const sec = Math.max(1, Math.floor((Date.now() - then) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60); if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60); if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24); return `${d}d ago`;
}

function rangeStatus(attackerScore: number, targetScore: number, nearPct: number) {
  const min = attackerScore * DECL_MIN;
  const max = attackerScore * DECL_MAX;
  const inRange = targetScore >= min && targetScore <= max;

  const lowNearMin = min * (1 - (nearPct / 100));
  const highNearMax = max * (1 + (nearPct / 100));
  const nearRange = (!inRange) && (
    (targetScore >= lowNearMin && targetScore < min) ||
    (targetScore > max && targetScore <= highNearMax)
  );

  return { inRange, nearRange, min, max, lowNearMin, highNearMax };
}
