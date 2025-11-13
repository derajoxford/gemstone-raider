// src/jobs/poll_aid.ts
import type { Client } from "discord.js";

export function startAidPoller(_client: Client) {
  // Minimal stub to keep builds green while we focus on War Rooms.
  if (process.env.AID_POLL_MS) {
    console.log(`[aid] (stub) poller configured but disabled for now.`);
  } else {
    console.log(`[aid] (stub) poller not configured.`);
  }
}
