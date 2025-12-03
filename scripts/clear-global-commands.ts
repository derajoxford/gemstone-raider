// scripts/clear-global-commands.ts
import "dotenv/config";
import { REST, Routes } from "discord.js";

async function main() {
  const token = process.env.DISCORD_TOKEN;
  const appId = process.env.DISCORD_APP_ID || process.env.DISCORD_CLIENT_ID;

  if (!token || !appId) {
    console.error("[clear] Missing env vars:");
    console.error(
      `  DISCORD_TOKEN: ${token ? "✔" : "✘"}\n` +
        `  DISCORD_APP_ID / DISCORD_CLIENT_ID: ${appId ? "✔" : "✘"}`,
    );
    process.exit(1);
  }

  const rest = new REST({ version: "10" }).setToken(token);

  console.log("[clear] Fetching current GLOBAL commands…");
  const existing = (await rest.get(
    Routes.applicationCommands(appId),
  )) as unknown[];

  console.log(`[clear] Found ${existing.length} global command(s).`);

  if (existing.length === 0) {
    console.log("[clear] Nothing to delete.");
    return;
  }

  console.log("[clear] Deleting all GLOBAL commands for this app…");
  await rest.put(Routes.applicationCommands(appId), { body: [] });
  console.log("[clear] Global commands cleared.");
}

main().catch((err) => {
  console.error("[clear] Fatal error:", err);
  process.exit(1);
});
