// scripts/force-register-from-registry.ts
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import {
  REST,
  Routes,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";

const require = createRequire(import.meta.url);

type CommandFile = {
  default: {
    data: {
      toJSON: () => RESTPostAPIChatInputApplicationCommandsJSONBody;
      name?: string;
    };
    disabled?: boolean;
  };
};

async function main() {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.DISCORD_APP_ID ?? process.env.DISCORD_CLIENT_ID;
  const guildId = process.env.DISCORD_GUILD_ID;

  const missing: string[] = [];
  if (!token) missing.push("DISCORD_TOKEN");
  if (!clientId) missing.push("DISCORD_APP_ID or DISCORD_CLIENT_ID");
  if (!guildId) missing.push("DISCORD_GUILD_ID");

  if (missing.length) {
    console.error("[register] Missing env vars:", missing.join(", "));
    process.exit(1);
  }

  const commandsPath = path.join(process.cwd(), "dist", "commands");
  if (!fs.existsSync(commandsPath)) {
    console.error(
      "[register] dist/commands does not exist. Did you run `npm run build`?",
    );
    process.exit(1);
  }

  const files = fs.readdirSync(commandsPath).filter((f) => f.endsWith(".js"));
  const body: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [];

  for (const file of files) {
    try {
      const mod: CommandFile = require(path.join(commandsPath, file));
      const cmd = mod.default;
      if (!cmd?.data || typeof cmd.data.toJSON !== "function") {
        console.warn(`[register] Skipping ${file}: no data.toJSON()`);
        continue;
      }
      // optional disabled flag
      // @ts-ignore runtime-only
      if (cmd.disabled) {
        console.log(`[register] Skipping ${file}: disabled`);
        continue;
      }

      const json = cmd.data.toJSON();
      console.log(`[register] Including /${json.name} from ${file}`);
      body.push(json);
    } catch (err) {
      console.error(`[register] Failed loading ${file}:`, err);
    }
  }

  console.log(`[register] Registering ${body.length} commands…`);

  const rest = new REST({ version: "10" }).setToken(token!);

  await rest.put(
    Routes.applicationGuildCommands(clientId!, guildId!),
    { body },
  );

  console.log(
    `[register] Successfully registered ${body.length} commands to guild ${guildId}`,
  );
}

main().catch((err) => {
  console.error("[register] Fatal error:", err);
  process.exit(1);
});
