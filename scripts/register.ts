// scripts/register.ts
import "dotenv/config";
import { REST, Routes } from "discord.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Token / client / guild from env
const token = (
  process.env.DISCORD_BOT_TOKEN ||
  process.env.DISCORD_TOKEN ||
  ""
).trim();
const clientId = (process.env.DISCORD_CLIENT_ID || "").trim();
const guildId = (
  process.env.GUILD_ID ||
  process.env.WAR_ALERTS_GUILD_ID ||
  process.env.RAIDER_GUILD_ID ||
  ""
).trim();

if (!token || !clientId) {
  console.error(
    "[register] Missing DISCORD_BOT_TOKEN/DISCORD_TOKEN or DISCORD_CLIENT_ID",
  );
  process.exit(1);
}

async function loadCommands() {
  const commandsDir = path.join(__dirname, "..", "src", "commands");
  let files: string[] = [];
  try {
    files = fs
      .readdirSync(commandsDir)
      .filter((f) => f.endsWith(".ts") || f.endsWith(".js"));
  } catch (err) {
    console.error(
      "[register] Failed to read commands directory",
      commandsDir,
      err,
    );
    process.exit(1);
  }

  const commands: any[] = [];

  for (const file of files) {
    const fullPath = path.join(commandsDir, file);
    try {
      const url = pathToFileURL(fullPath).href;
      const mod = await import(url);
      const cmd = mod.default || mod.command || mod;

      if (!cmd || !cmd.data || typeof cmd.data.toJSON !== "function") {
        console.log(
          "[register] skipping",
          file,
          "(no default.data.toJSON)",
        );
        continue;
      }

      commands.push(cmd.data.toJSON());
      console.log("[register] loaded", cmd.data.name, "from", file);
    } catch (err) {
      console.error("[register] error loading", file, err);
    }
  }

  return commands;
}

async function main() {
  const commands = await loadCommands();

  if (!commands.length) {
    console.error("[register] No commands loaded, aborting");
    process.exit(1);
  }

  const rest = new REST({ version: "10" }).setToken(token);

  if (guildId) {
    console.log(
      "[register] Registering",
      commands.length,
      "guild commands to",
      guildId,
    );
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
      body: commands,
    });
    console.log("[register] Registered guild commands:", guildId);
  } else {
    console.log(
      "[register] No GUILD_ID/WAR_ALERTS_GUILD_ID/RAIDER_GUILD_ID; registering global commands",
    );
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log("[register] Registered global commands.");
  }
}

main().catch((e) => {
  console.error("[register] fatal error", e);
  process.exit(1);
});
