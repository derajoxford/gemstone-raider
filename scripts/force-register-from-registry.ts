// scripts/force-register-from-registry.ts

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REST, Routes } from "discord.js";

type CommandShape = {
  toJSON?: () => unknown;
};

type CommandModule = {
  data?: CommandShape;
  builder?: CommandShape;
  default?: {
    data?: CommandShape;
    builder?: CommandShape;
  };
};

async function loadCommandsFromDist(): Promise<unknown[]> {
  const commandsDir = path.join(process.cwd(), "dist", "commands");

  if (!fs.existsSync(commandsDir)) {
    throw new Error(
      `[register] dist/commands does not exist at ${commandsDir}. Did you run "npm run build"?`,
    );
  }

  const files = fs
    .readdirSync(commandsDir)
    .filter((f) => f.endsWith(".js"));

  const out: unknown[] = [];

  for (const file of files) {
    const full = path.join(commandsDir, file);
    try {
      const mod = (await import(pathToFileURL(full).href)) as CommandModule;

      const shape: CommandShape | undefined =
        mod.data ??
        mod.builder ??
        mod.default?.data ??
        mod.default?.builder;

      if (!shape || typeof shape.toJSON !== "function") {
        console.warn(
          `[register] Skipping ${file} (no data/builder.toJSON found)`,
        );
        continue;
      }

      out.push(shape.toJSON());
      console.log(`[register] Loaded command from ${file}`);
    } catch (err) {
      console.error(`[register] Error loading ${file}:`, err);
    }
  }

  console.log(
    `[register] Collected ${out.length} command(s) from dist/commands`,
  );
  return out;
}

async function main() {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;
  const guildId = process.env.DISCORD_GUILD_ID;

  if (!token || !clientId || !guildId) {
    console.error("[register] Missing one or more env vars:");
    console.error("  DISCORD_TOKEN:", token ? "✔" : "✘");
    console.error("  DISCORD_CLIENT_ID:", clientId ? "✔" : "✘");
    console.error("  DISCORD_GUILD_ID:", guildId ? "✔" : "✘");
    process.exit(1);
  }

  const commands = await loadCommandsFromDist();

  const rest = new REST({ version: "10" }).setToken(token);

  console.log(
    `[register] Pushing ${commands.length} command(s) to guild ${guildId} for app ${clientId}...`,
  );

  try {
    await rest.put(
      Routes.applicationGuildCommands(clientId, guildId),
      { body: commands },
    );
    console.log("[register] Slash commands updated successfully.");
  } catch (err) {
    console.error("[register] Failed to update commands:");
    console.error(err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[register] Unhandled error:", err);
  process.exit(1);
});
