import "dotenv/config";
import { REST, Routes } from "discord.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCommandsFrom } from "../src/core/registry.js";

const token = process.env.DISCORD_TOKEN!;
const appId = process.env.DISCORD_APP_ID!;
const guildCsv = process.env.ALLOWED_GUILDS || "";
const guilds = guildCsv.split(",").map(s => s.trim()).filter(Boolean);

if (!token || !appId || guilds.length === 0) {
  console.error("Missing DISCORD_TOKEN, DISCORD_APP_ID, or ALLOWED_GUILDS in env.");
  process.exit(1);
}

const rest = new REST({ version: "10" }).setToken(token);

// Load command JSON from src when using tsx
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcCommandsDir = path.resolve(__dirname, "../src/commands");
const commands = (await loadCommandsFrom(srcCommandsDir)).map(c => c.data.toJSON());

for (const gid of guilds) {
  console.log(`Registering ${commands.length} commands to guild ${gid}...`);
  await rest.put(Routes.applicationGuildCommands(appId, gid), { body: commands });
  console.log(`✅ Registered in ${gid}`);
}
