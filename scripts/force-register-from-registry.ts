// scripts/force-register-from-registry.ts
import "dotenv/config";
import { REST, Routes } from "discord.js";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

type CommandModule = {
  default?: {
    data?: {
      name?: string;
      toJSON?: () => unknown;
    };
  };
};

async function main() {
  const token = process.env.DISCORD_TOKEN;
  const appId = process.env.DISCORD_APP_ID || process.env.DISCORD_CLIENT_ID;
  const guildId = process.env.DISCORD_GUILD_ID;

  if (!token || !appId || !guildId) {
    console.error("[register] Missing env vars:");
    console.error(
      `  DISCORD_TOKEN: ${token ? "✔" : "✘"}\n` +
        `  DISCORD_APP_ID / DISCORD_CLIENT_ID: ${
          appId ? "✔" : "✘"
        }\n` +
        `  DISCORD_GUILD_ID: ${guildId ? "✔" : "✘"}`,
    );
    process.exit(1);
  }

  const rest = new REST({ version: "10" }).setToken(token);

  const commandsPath = path.join(process.cwd(), "dist", "commands");
  if (!fs.existsSync(commandsPath)) {
    console.error("[register] dist/commands not found – did you run `npm run build`?");
    process.exit(1);
  }

  const files = fs
    .readdirSync(commandsPath)
    .filter((f) => f.endsWith(".js"))
    .sort();

  const payload: unknown[] = [];

  for (const file of files) {
    const full = path.join(commandsPath, file);
    try {
      const mod: CommandModule = require(full);
      const cmd = mod.default;
      if (!cmd || !cmd.data || typeof cmd.data.toJSON !== "function") {
        console.log(
          `[register] Skipping ${file}: no data.toJSON() on default export`,
        );
        continue;
      }
      const json = cmd.data.toJSON() as { name?: string };
      const name = json.name ?? file.replace(/\.js$/, "");
      console.log(`[register] Including /${name} from ${file}`);
      payload.push(json);
    } catch (err) {
      console.error(`[register] Error loading ${file}:`, err);
    }
  }

  console.log(
    `[register] Registering ${payload.length} commands to guild ${guildId}…`,
  );

  await rest.put(
    Routes.applicationGuildCommands(appId, guildId),
    { body: payload },
  );

  console.log(
    `[register] Successfully registered ${payload.length} commands to guild ${guildId}`,
  );
}

main().catch((err) => {
  console.error("[register] Fatal error:", err);
  process.exit(1);
});
