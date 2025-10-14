import { TextChannel, ChannelType, Client, Guild } from "discord.js";
import { query } from "../data/db.js";
import { getGuildSettings } from "../data/settings.js";
import { fetchAidSince, fetchPriceMap } from "../pnw/client.js";
import { fetchNationMap } from "../pnw/nations.js";
import { depositAlertEmbed } from "../ui/embeds.js";
import { bankRowWithWatch } from "../ui/radar.js";
import { watchersForNation } from "../data/watch.js";

/** Declare window used for in/near range checks */
const DECL_MIN = 0.75;
const DECL_MAX = 2.50;

/** Entry: starts the periodic poller */
export function startAidPoller(client: Client) {
  const loop = async () => {
    try {
      await runOnce(client);
    } catch (e) {
      console.error("Aid poller error:", e);
    }
  };

  loop();
  const ms = Number(process.env.AID_POLL_MS ?? 90_000);
  setInterval(loop, ms);
}

/** One polling iteration */
async function runOnce(client: Client) {
  const guildId =
    (process.env.ALLOWED_GUILDS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)[0] || "";

  if (!guildId) return;

  const guild =
    client.guilds.cache.get(guildId) ||
    (await client.guilds.fetch(guildId).catch(() => null));
  if (!guild) return;

  const gs = await getGuildSettings(guildId);
  if (!gs.alerts_enabled || !gs.deposits_enabled) return;

  // ---- cursor (what we've seen so far) ----
  const cur = await query("SELECT last_aid_id, last_seen_at FROM aid_cursor WHERE id=1");
  const lastAidId: number | undefined = cur.rows[0]?.last_aid_id ?? undefined;
  const lastSeenIso: string | undefined = cur.rows[0]?.last_seen_at ?? undefined;

  // ---- fetch newest aid/deposits since the cursor ----
  const aid = await fetchAidSince(lastAidId, lastSeenIso);
  if (!aid.length) return;

  const prices = await fetchPriceMap();

  // all linked raider nations (for in/near-range routing if needed)
  const raiders = await query(
    "SELECT discord_user_id, nation_id FROM user_nation WHERE is_primary=true"
  );
  const raiderIds = raiders.rows
    .map((r) => Number(r.nation_id))
    .filter(Number.isFinite);

  // Try to get/create the bank radar channel
  const bankChannel = await ensureTextChannel(
    guild,
    gs.deposits_channel_id || null,
    "bank-radar"
  );

  // process oldest → newest so the cursor always moves forward
  const ordered = [...aid].sort((a, b) => a.id - b.id);
  let newestId = lastAidId ?? 0;
  let newestTs: string | undefined = lastSeenIso;

  for (const ev of ordered) {
    newestId = Math.max(newestId, ev.id);
    newestTs = ev.sentAt;

    const notional = computeNotionalUSD(ev, prices);

    // Guild floor thresholds (use your *actual* columns)
    const absGuild = Number(gs.deposit_threshold_abs_usd ?? 0);
    const relGuild = Number(gs.deposit_threshold_rel_pct ?? 0);

    // NOTE: relGuild not used yet (v1); future: compare to loot p50/avg
    const floor = absGuild > 0 ? absGuild : 10_000_000;
    if (notional < floor) continue;

    // dedupe by id+receiver+rounded notional
    const hash = `bank-${ev.id}-${ev.receiverId}-${Math.round(notional)}`;
    const { rows: existing } = await query(
      "SELECT 1 FROM alert_log WHERE message_hash=$1",
      [hash]
    );
    if (existing.length) continue;

    // fetch target + relevant raiders for in/near-range checks
    const nationMap = await fetchNationMap([ev.receiverId, ...raiderIds]);
    const target = nationMap[ev.receiverId];

    // Optional in/near-range gate for channel posts:
    // if you later add a boolean to guild_settings (e.g., inrange_only),
    // you can read it here. For now, always allow channel posts.
    let anyInRange = true;
    if (target && typeof target.score === "number") {
      const nearPct = gs.near_range_pct ?? 5;
      // uncomment to enable guild-level in/near-range gating:
      // anyInRange = raiderIds.some((rid) => {
      //   const rn = nationMap[rid];
      //   if (!rn || typeof rn.score !== "number") return false;
      //   const s = rangeStatus(rn.score, target.score, nearPct);
      //   return s.inRange || s.nearRange;
      // });
    }

    if (!anyInRange) {
      // still advance cursor, but skip posting
      continue;
    }

    // Build channel payload (with 🔔 button)
    const payload = depositAlertEmbed({
      nationId: ev.receiverId,
      nationName: ev.receiverName,
      senderId: ev.senderId ?? undefined,
      senderName: ev.senderName ?? undefined,
      notionalUSD: Math.round(notional),
      breakdown: buildBreakdown(ev),
      whenText: timeAgo(ev.sentAt),
    });
    const components = [...(payload.components ?? [])];
    components.push(bankRowWithWatch(ev.receiverId));

    // Channel post
    if (bankChannel) {
      await bankChannel
        .send({
          ...payload,
          components,
          allowedMentions: { parse: [] },
        })
        .catch(() => null);
    }

    // DM watchers of this nation (per-user thresholds & inrange_only respected)
    const watchers = await watchersForNation(ev.receiverId);
    if (watchers.length && target && typeof target.score === "number") {
      const targetScore = target.score;
      for (const w of watchers) {
        const member = await guild.members
          .fetch(w.discord_user_id)
          .catch(() => null);
        const user = member?.user;
        if (!user) continue;

        // per-user threshold: fall back to guild floor
        const myFloor = Number(w.bank_abs_usd ?? floor);
        if (notional < myFloor) continue;

        // in/near-range filter (per-user)
        if (w.inrange_only) {
          // need their attacker score
          const myNation = await query(
            "SELECT nation_id FROM user_nation WHERE discord_user_id=$1 AND is_primary=true LIMIT 1",
            [w.discord_user_id]
          );
          const nid = myNation.rows[0]?.nation_id;
          if (!nid) continue;
          const attacker = nationMap[nid];
          if (!attacker || typeof attacker.score !== "number") continue;

          const s = rangeStatus(attacker.score, targetScore, gs.near_range_pct ?? 5);
          if (!s.inRange && !s.nearRange) continue;
        }

        await user
          .send({
            ...payload,
            components,
            allowedMentions: { parse: [] },
          })
          .catch(() => null);

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

  // advance cursor
  await query(
    "UPDATE aid_cursor SET last_aid_id=$1, last_seen_at=$2 WHERE id=1",
    [newestId || null, newestTs || null]
  );
}

/** USD notional based on resource market prices */
function computeNotionalUSD(ev: any, priceMap: Record<string, number>) {
  let total = Number(ev.cash ?? 0);
  const resources = [
    "food",
    "munitions",
    "steel",
    "oil",
    "aluminum",
    "uranium",
    "gasoline",
    "coal",
    "iron",
    "bauxite",
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
    if (v) parts.push(`${fmt(v)} ${label || k}`);
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
  return parts.join(" • ");
}

function fmt(n: number) {
  return Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n);
}

function timeAgo(iso: string | undefined) {
  if (!iso) return "just now";
  const then = new Date(iso).getTime();
  const now = Date.now();
  const s = Math.max(1, Math.round((now - then) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

function rangeStatus(attackerScore: number, targetScore: number, nearPct: number) {
  const min = targetScore * DECL_MIN;
  const max = targetScore * DECL_MAX;
  const inRange = attackerScore >= min && attackerScore <= max;
  const nearRange =
    !inRange &&
    attackerScore >= min * (1 - nearPct / 100) &&
    attackerScore <= max * (1 + nearPct / 100);
  return { inRange, nearRange, min, max };
}

/** Ensure we have a text channel to post bank radar alerts to */
async function ensureTextChannel(
  guild: Guild,
  channelId: string | null,
  fallbackName: string
): Promise<TextChannel | null> {
  if (channelId) {
    const byId = (await guild.channels.fetch(channelId).catch(() => null)) as TextChannel | null;
    if (byId && byId.type === ChannelType.GuildText) return byId;
  }

  // try to find by name
  const existing = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildText && c.name === fallbackName
  ) as TextChannel | undefined;
  if (existing) return existing;

  // try to create (requires permission)
  const created = (await guild.channels
    .create({
      name: fallbackName,
      type: ChannelType.GuildText,
      reason: "PNW Raider: bank radar channel",
    })
    .catch(() => null)) as TextChannel | null;

  return created;
}
