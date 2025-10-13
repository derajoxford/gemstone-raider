import type { Client, Guild, TextChannel } from "discord.js";
import { getGuildSettings } from "../data/settings.js";
import { query } from "../data/db.js";
import { fetchNationMap } from "../pnw/nations.js";
import { beigeSoonEmbed, slotOpenEmbed } from "../ui/radar.js";
import { listWatches } from "../data/watch.js";

export function startWatchRadar(client: Client) {
  const loop = async () => {
    try { await runOnce(client); } catch (e) { console.error("Watch radar error:", e); }
  };
  loop();
  setInterval(loop, Number(process.env.RADAR_POLL_MS ?? 60_000));
}

async function runOnce(client: Client) {
  const guildId = (process.env.ALLOWED_GUILDS || "").split(",").map(s=>s.trim()).filter(Boolean)[0];
  if (!guildId) return;
  const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return;

  const gs = await getGuildSettings(guildId);
  const beigeChannel = await ensureTextChannel(client, guild, gs.beige_radar_channel_id, "beige-radar");

  // Gather watched nations for members in this guild
  const members = await guild.members.fetch();
  const userIds = members.map(m => m.id);

  // flatten watches
  const watches: { uid: string; nation: number; earlyMin: number | null }[] = [];
  for (const uid of userIds) {
    const my = await listWatches(uid);
    for (const w of my) watches.push({ uid, nation: w.nation_id, earlyMin: w.beige_early_min ?? null });
  }
  if (!watches.length) return;

  const uniqueNationIds = Array.from(new Set(watches.map(w => w.nation)));
  const nationMap = await fetchNationMap(uniqueNationIds);

  // Iterate nations; compute beige soon & slots
  for (const nid of uniqueNationIds) {
    const n = nationMap[nid]; if (!n) continue;

    // slot open (def or off)
    const offActive = clamp(0,3, n.offensiveWars ?? 0);
    const defActive = clamp(0,3, n.defensiveWars ?? 0);
    const offOpen = 3 - offActive, defOpen = 3 - defActive;
    if ((offOpen>0 || defOpen>0) && beigeChannel) {
      // cooldown: skip if we posted in last 30m
      const dup = await recentAlert("slot_open", nid, 30);
      if (!dup) {
        await beigeChannel.send({ ...(slotOpenEmbed({ nationId: nid, nationName: n.name, offOpen, defOpen }) as any) }).catch(()=>null);
        await logAlert("slot_open", nid, offOpen+defOpen, `slot-${nid}-${offOpen}-${defOpen}`);
      }
    }

    // beige soon: if beige_turns > 0 and will expire within anyone's earlyMin (default 60m)
    const turns = n.beigeTurns ?? 0;
    if (turns > 0) {
      const minsLeft = turns * 60;
      // anyone asking to be pinged early?
      const watchers = watches.filter(w => w.nation === nid);
      const defaultEarly = 60; // 1 hour default lead for DM if not specified
      const needsDM = watchers.filter(w => (w.earlyMin ?? defaultEarly) >= minsLeft);
      if (needsDM.length) {
        // channel beacon (once per 30m per nation)
        if (beigeChannel) {
          const dup = await recentAlert("beige_soon", nid, 30);
          if (!dup) {
            await beigeChannel.send({
              ...(beigeSoonEmbed({
                nationId: nid, nationName: n.name, exitsInMin: Math.max(1, Math.round(minsLeft)),
                offSlotsOpen: offOpen, defSlotsOpen: defOpen, lastActiveMin: n.lastActiveMinutes ?? null, nearPct: gs.near_range_pct
              }) as any)
            }).catch(()=>null);
            await logAlert("beige_soon", nid, minsLeft, `beige-${nid}-${turns}`);
          }
        }
        // DMs to requesters
        for (const w of needsDM) {
          const m = await guild.members.fetch(w.uid).catch(()=>null);
          const u = m?.user; if (!u) continue;
          await u.send({
            ...(beigeSoonEmbed({
              nationId: nid, nationName: n.name, exitsInMin: Math.max(1, Math.round(minsLeft)),
              offSlotsOpen: offOpen, defSlotsOpen: defOpen, lastActiveMin: n.lastActiveMinutes ?? null, nearPct: gs.near_range_pct,
              statusText: "Your watchlist requested early DM."
            }) as any),
            allowedMentions: { parse: [] }
          }).catch(()=>null);
        }
      }
    }
  }
}

async function recentAlert(type: string, nationId: number, minutes: number) {
  const { rows } = await query<{ id: number }>(
    `SELECT id FROM alert_log WHERE event_type=$1 AND nation_id=$2 AND created_at > now() - ($3::text || ' minutes')::interval LIMIT 1`,
    [type, nationId, String(minutes)]
  );
  return rows.length > 0;
}
async function logAlert(type: string, nationId: number, value: number, hash: string) {
  await query("INSERT INTO alert_log (event_type, nation_id, notional_value, message_hash) VALUES ($1,$2,$3,$4)", [type, nationId, Math.round(value), hash]);
}

function clamp(lo:number, hi:number, v:number){ return Math.max(lo, Math.min(hi, v)); }

async function ensureTextChannel(client: Client, guild: Guild, id: string|null, defaultName: string) {
  if (id) {
    const ch = await client.channels.fetch(id).catch(() => null);
    if (ch && (ch as any).send) return ch as TextChannel;
  }
  const existing = guild.channels.cache.find(c => c.isTextBased() && c.name === defaultName) as TextChannel | undefined;
  if (existing) return existing;
  try {
    const created = await guild.channels.create({ name: defaultName, reason: "PNW Raider Radar" });
    return created as TextChannel;
  } catch { return null; }
}
