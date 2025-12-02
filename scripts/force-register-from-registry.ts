// scripts/force-register-from-registry.ts
import "dotenv/config";
import { REST, Routes } from "discord.js";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const token = process.env.DISCORD_TOKEN;
const clientId =
  process.env.DISCORD_CLIENT_ID || process.env.DISCORD_APP_ID || "";
const guildId = process.env.DISCORD_GUILD_ID || "";

function fail(msg: string): never {
  console.error("[register] " + msg);
  process.exit(1);
}

if (!token || !clientId || !guildId) {
  console.error("[register] Missing env vars:");
  console.error(`  DISCORD_TOKEN: ${token ? "✔" : "✘"}`);
  console.error(`  DISCORD_CLIENT_ID / DISCORD_APP_ID: ${clientId ? "✔" : "✘"}`);
  console.error(`  DISCORD_GUILD_ID: ${guildId ? "✔" : "✘"}`);
  process.exit(1);
}

const rest = new REST({ version: "10" }).setToken(token);

async function main() {
  const commands: any[] = [];
  const commandsPath = path.join(process.cwd(), "dist", "commands");

  if (!fs.existsSync(commandsPath)) {
    fail("dist/commands not found. Did you run `npm run build`?");
  }

  const files = fs
    .readdirSync(commandsPath)
    .filter((file) => file.endsWith(".js"));

  for (const file of files) {
    const fullPath = path.join(commandsPath, file);
    try {
      const mod = require(fullPath);
      const cmd = mod.default ?? mod;

      if (!cmd || !cmd.data) {
        console.warn(
          `[register] Skipping ${file}: no data property on default export`,
        );
        continue;
      }

      let json: any;

      // Case 1: SlashCommandBuilder-style (has toJSON)
      if (typeof cmd.data.toJSON === "function") {
        json = cmd.data.toJSON();
      } else if (typeof cmd.data === "object") {
        // Case 2: Plain object with name/description
        json = cmd.data;
      } else {
        console.warn(
          `[register] Skipping ${file}: data is not a builder or plain object`,
        );
        continue;
      }

      if (!json || typeof json.name !== "string") {
        console.warn(
          `[register] Skipping ${file}: data missing 'name' after normalization`,
        );
        continue;
      }

      console.log(`[register] Including /${json.name} from ${file}`);
      commands.push(json);
    } catch (err) {
      console.error(`[register] Error loading ${file}:`, err);
    }
  }

  console.log(`[register] Registering ${commands.length} commands…`);

  await rest.put(
    Routes.applicationGuildCommands(clientId, guildId),
    { body: commands },
  );

  console.log(
    `[register] Successfully registered ${commands.length} commands to guild ${guildId}`,
  );
}

main().catch((err) => {
  console.error("[register] Fatal error:", err);
  process.exit(1);
});
