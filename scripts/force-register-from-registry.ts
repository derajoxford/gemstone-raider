// scripts/force-register-from-registry.ts

import "dotenv/config";
import { REST, Routes } from "discord.js";

// NOTE: This assumes pnw-raider uses the same pattern as our other bots:
// src/commands/index.ts exports a `commandMap` containing all slash commands.
// If the name is different, we'll tweak this import.
import { commandMap } from "../src/commands/index.js";

type AnyCommandShape = {
  data?: { toJSON: () => unknown };
  builder?: { toJSON: () => unknown };
};

function collectCommands(): unknown[] {
  const raw = (commandMap instanceof Map
    ? Array.from(commandMap.values())
    : Object.values(commandMap as Record<string, AnyCommandShape>)) as AnyCommandShape[];

  const commands = raw.map((cmd, idx) => {
    const shape = cmd.data ?? cmd.builder;
    if (!shape || typeof shape.toJSON !== "function") {
      throw new Error(
        `Command at index ${idx} is missing a data/builder.toJSON() shape`,
      );
    }
    return shape.toJSON();
  });

  return commands;
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

  const rest = new REST({ version: "10" }).setToken(token);

  const body = collectCommands();
  console.log(
    `[register] Pushing ${body.length} commands to guild ${guildId} for app ${clientId}...`,
  );

  try {
    await rest.put(
      Routes.applicationGuildCommands(clientId, guildId),
      { body },
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
