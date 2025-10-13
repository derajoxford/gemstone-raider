import type { Client, Guild, TextChannel } from "discord.js";
import { query } from "../data/db.js";
import { getGuildSettings } from "../data/settings.js";
import { fetchAidSince, fetchPriceMap } from "../pnw/client.js";
import { fetchNationMap } from "../pnw/nations.js";
import { depositAlertEmbed } from "../ui/embeds.js";
import { bankRowWithWatch } from "../ui/radar.js";
import { watchersForNation } from "../data/watch.js";

const DECL_MIN = 0.75;
const DECL_MAX = 2.50;

export function startAidPoller(client: Client) {
  const loop = async () => {
    try { await runOnce(client); } catch (e) { console.error("Aid poller error:", e); }
  };
  loop();
  setInterval(loop, Number(process.env.AID_POLL_MS ?? 90_000));
}

async function runOnce(client: Client) {
  const guildId = (process.env.ALLOWED_GUILDS || "").split(",").map(s=>s.trim()).filter(Boolean)[0];
  if (!guildId) return;

  const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return;

  const gs = await getGuildSettings(guildId);
  if (!gs.alerts_enabled) return;

  // cursor
  const cur = await query<{ last_aid_id: number | null, last_seen_at: string | null }>(
    "SELECT last_aid_id, last_seen_at FROM aid_cursor WHERE id=1"
  );
  const lastAidId = cur.rows[0]?.last_aid_id ?? undefined;
  const lastSeenIso = cur.rows[0]?.last_seen_at ?? undefined;

  const aid = await fetchAidSince(lastAidId, lastSeenIso);
  if (!aid.length) return;

  const prices = await fetchPriceMap();

  // all linked raider nations (for in/near-range routing if needed)
  const raiders = await query<{ discord_user_id: string; nation_id: number }>(
    "SELECT discord_user_id, nation_id FROM user_nation WHERE is_primary=true"
  );
  const raiderIds = raiders.rows.map(r => Number(r.nation_id)).filter(Number.isFinite);

  // Try to get/create bank channel
  const bankChannel = await ensureTextChannel(client, guild, gs.bank_radar_channel_id, "bank-radar");

  // process oldest → newest
  const ordered = [...aid].sort((a, b) => a.id - b.id);

  let newestId = lastAidId ?? 0;
  let newestTs: string | undefined = lastSeenIso;

  for (const ev of ordered) {
    newestId = Math.max(newestId, ev.id);
    newestTs = ev.sentAt;

    const notional = computeNotionalUSD(ev as any, prices);
    const floor = gs.bank_abs_usd ?? 10_000_000;
    if (notional < floor) continue;

    // dedupe by id+receiver+rounded
    const hash = `bank-${ev.id}-${ev.receiverId}-${Math.round(notional)}`;
    const { rows: existing } = await query("SELECT 1 FROM alert_log WHERE message_hash=$1", [hash]);
    if (existing.length) continue;

    // fetch target + raiders for in/near-range checks
    const nationMap = await fetchNationMap([ev.receiverId, ...raiderIds]);
    const target = nationMap[ev.receiverId];

    // in/near-range present in guild?
    let anyInRange = true;
    if (gs.inrange_only && target && typeof target.score === "number") {
      const nearPct = gs.near_range_pct ?? 5;
      const tScore: number = target.score; // hard narrow
      anyInRange = raiderIds.some(rid => {
        const rn = nationMap[rid];
        if (!rn || typeof rn.score !== "number") return false;
        const aScore: number = rn.score; // hard narrow
        const s = rangeStatus(aScore, tScore, nearPct);
        return s.inRange || s.nearRange;
      });
    }
    if (!anyInRange) {
      // still update cursor, but skip posting
      continue;
    }

    // Build channel payload (with 🔔 button)
    const payload = depositAlertEmbed({
      nationId: ev.receiverId,
      nationName: ev.receiverName,
      senderId: ev.senderId ?? undefined,
      senderName: ev.senderName ?? undefined,
      notionalUSD: Math.round(notional),
      breakdown: buildBreakdown(ev as any),
      whenText: timeAgo(ev.sentAt)
    });
    const components = [...(payload as any).components ?? []];
    components.push(bankRowWithWatch(ev.receiverId));

    if (bankChannel) {
      await bankChannel.send({
        ...(payload as any),
        components,
        allowedMentions: { parse: [] }
      }).catch(() => null);
    }

    // DM watchers of this nation (per-user thresholds & inrange_only)
    const watchers = await watchersForNation(ev.receiverId);
    if (watchers.length && target && typeof target.score === "number") {
      const targetScore: number = target.score; // hard narrow
      for (const w of watchers) {
        const member = await guild.members.fetch(w.discord_user_id).catch(() => null);
        const user = member?.user; if (!user) continue;

        // threshold check
        const myFloor = w.bank_abs_usd ?? floor;
        if (notional < myFloor) continue;

        // in/near-range filter (per-user)
        if (w.inrange_only) {
          // need their attacker score
          const myNation = await query<{ nation_id: number }>(
            "SELECT nation_id FROM user_nation WHERE discord_user_id=$1 AND is_primary=true LIMIT 1",
            [w.discord_user_id]
          );
          const nid = myNation.rows[0]?.nation_id; if (!nid) continue;
          const attacker = nationMap[nid];
          if (!attacker || typeof attacker.score !== "number") continue;
          const aScore: number = attacker.score; // hard narrow
          const s = rangeStatus(aScore, targetScore, gs.near_range_pct ?? 5);
          if (!s.inRange && !s.nearRange) continue;
        }

        await user.send({
          ...(payload as any),
          components,
          allowedMentions: { parse: [] }
        }).catch(() => null);

        await query(
          "INSERT INTO alert_log (event_type, nation_id, notional_value, message_hash) VALUES ($1,$2,$3,$4)",
          ["deposit_watch_dm", ev.receiverId, Math.round(notional), `${hash}-u${w.discord_user_id}`]
        );
      }
    }

    // log
    await query(
      "INSERT INTO alert_log (event_type, nation_id, notional_value, message_hash) VALUES ($1,$2,$3,$4)",
      ["deposit", ev.receiverId, Math.round(notional), hash]
    );
  }

  await query("UPDATE aid_cursor SET last_aid_id=$1, last_seen_at=$2 WHERE id=1", [newestId || null, newestTs || null]);
}

function computeNotionalUSD(ev: any, priceMap: Record<string, number>) {
  let total = Number(ev.cash ?? 0);
  const resources: string[] = ["food","munitions","steel","oil","aluminum","uranium","gasoline","coal","iron","bauxite"];
  for (const r of resources) {
    const qty = Number(ev[r] ?? 0); if (!qty) continue;
    const p = Number(priceMap[r] ?? 0); if (!p) continue;
    total += qty * p;
  }
  return total;
}
function buildBreakdown(ev: any) {
  const parts: string[] = [];
  if (ev.cash) parts.push(`$${fmt(ev.cash)} cash`);
  const add = (k: string) => { const v = Number(ev[k] ?? 0); if (v) parts.push(`${fmt(v)} ${k}`); };
  ["food","munitions","steel","oil","aluminum","uranium","gasoline","coal","iron","bauxite"].forEach(add);
  return parts.join(" • ");
}
function fmt(n: number) { return Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n); }
function timeAgo(iso: string) {
  const then = new Date(iso).getTime(); const sec = Math.max(1, Math.floor((Date.now()-then)/1000));
  if (sec<60) return `${sec}s ago`; const m=Math.floor(sec/60); if(m<60) return `${m}m ago`;
  const h=Math.floor(m/60); if(h<24) return `${h}h ago`; const d=Math.floor(h/24); return `${d}d ago`;
}
function rangeStatus(attackerScore: number, targetScore: number, nearPct: number) {
  const min=attackerScore*DECL_MIN, max=attackerScore*DECL_MAX;
  const inRange = targetScore>=min && targetScore<=max;
  const near = (!inRange) && ((targetScore>=min*(1-nearPct/100) && targetScore<min) || (targetScore>max && targetScore<=max*(1+nearPct/100)));
  return { inRange, nearRange: near };
}

async function ensureTextChannel(client: Client, guild: Guild, id: string|null, defaultName: string) {
  if (id) {
    const ch = await client.channels.fetch(id).catch(() => null);
    if (ch && (ch as any).send) return ch as TextChannel;
  }
  // try to find by name; else create
  const existing = guild.channels.cache.find(c => c.isTextBased() && c.name === defaultName) as TextChannel | undefined;
  if (existing) return existing;
  try {
    const created = await guild.channels.create({ name: defaultName, reason: "PNW Raider Bank Radar" });
    return created as TextChannel;
  } catch { return null; }
}
