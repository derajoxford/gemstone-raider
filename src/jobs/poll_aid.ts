// src/jobs/poll_aid.ts
import type { Client } from "discord.js";

export function startAidPoller(_client: Client) {
  // Build-safe stub so Aid job stops breaking deploys while we finish War Rooms
  if (process.env.AID_POLL_MS) {
    console.log(`[aid] (stub) poller configured but disabled for now.`);
  } else {
    console.log(`[aid] (stub) poller not configured.`);
  }
}
