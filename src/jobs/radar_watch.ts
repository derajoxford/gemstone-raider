// src/jobs/radar_watch.ts
// Watch / Beige radar loop WITHOUT GuildMembers intent.
// - No guild.members.fetch()
// - Safe with only GatewayIntentBits.Guilds
// - Logs a periodic tick so you can verify cadence
// - Placeholder for beige exit logic & per-user DMs using client.users.fetch()

import type { Client } from "discord.js";
import { query } from "../data/db.js";

function ms(n: number) { return Math.max(0, Math.floor(n)); }
function withJitter(baseMs: number, pct = 0.30) {
  const delta = baseMs * pct;
  return ms(baseMs + (Math.random() * 2 - 1) * delta);
}

export function startWatchRadar(client: Client) {
  const baseSec = Number(process.env.WATCH_POLL_SEC || "10"); // default 10s
  const baseMs = ms(baseSec * 1000);

  let timer: NodeJS.Timeout | null = null;

  const tick = async () => {
    try {
      // Lightweight heartbeat + visibility into DB content
      const { rows } = await query<{ c: number }>("select count(*)::int as c from watchlist");
      const watchers = rows?.[0]?.c ?? 0;
      console.log(`Watch radar tick — watchers=${watchers}`);

      // TODO: implement beige exit ETA & target checks here
      // 1) Pull active watches:
      //    const { rows: w } = await query("select discord_user_id, nation_id, dm_enabled from watchlist");
      // 2) For each nation_id, fetch status from PNW API (no guild member fetch!)
      // 3) If approaching beige exit / in-window, DM the user:
      //    const user = await client.users.fetch(discord_user_id);
      //    await user.send({ content: "...", embeds: [...] });

    } catch (e) {
      console.error("Watch radar error:", e);
    } finally {
      timer = setTimeout(tick, withJitter(baseMs, 0.30));
    }
  };

  // initial kick after a short delay
  timer = setTimeout(tick, withJitter(Math.min(baseMs, 5000), 0.30));

  // graceful stop
  const stop = () => { if (timer) clearTimeout(timer); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
