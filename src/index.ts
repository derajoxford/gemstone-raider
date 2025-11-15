// src/index.ts
import "dotenv/config";
import {
  Client,
  Collection,
  GatewayIntentBits,
  Interaction,
  MessageFlags,
} from "discord.js";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

import type { Command } from "./types/command.js";
import { startAidPoller } from "./jobs/poll_aid.js";
import { startWatchRadar } from "./jobs/radar_watch.js";
import { addOrUpdateWatch, removeWatch } from "./data/watch.js";
import { getGuildSettings } from "./data/settings.js";
import { query } from "./data/db.js";
import { ensureCommandAllowed } from "./command_gate.js"; // 👈 NEW

const token = process.env.DISCORD_TOKEN!;
const appId = process.env.DISCORD_APP_ID!;
if (!token || !appId) {
  throw new Error("Missing DISCORD_TOKEN or DISCORD_APP_ID");
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = new Collection<string, Command>();

function loadCommands() {
  const commandsPath = path.join(process.cwd(), "dist", "commands");
  if (!fs.existsSync(commandsPath)) {
    console.warn("dist/commands not found; did you build?");
    return;
  }
  const files = fs.readdirSync(commandsPath).filter((f) => f.endsWith(".js"));
  for (const file of files) {
    try {
      const mod = require(path.join(commandsPath, file));
      const cmd: Command = mod.default;
      if (!cmd?.data || typeof cmd.execute !== "function") continue;
      // honor optional disabled flag
      // @ts-ignore runtime check only
      if (cmd.disabled) continue;
      commands.set(cmd.data.name, cmd);
    } catch (e) {
      console.error(`Failed loading command ${file}:`, e);
    }
  }
  console.log(`Loaded ${commands.size} command(s).`);
}

client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user?.tag}`);
  try {
    startAidPoller(client);
  } catch (e) {
    console.error("Failed to start Aid Poller:", e);
  }
  try {
    startWatchRadar(client);
  } catch (e) {
    console.error("Failed to start Watch Radar:", e);
  }
});

client.on("interactionCreate", async (interaction: Interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      // 👇 Gate everything except /command_roles itself
      if (interaction.commandName !== "command_roles") {
        const ok = await ensureCommandAllowed(interaction);
        if (!ok) return;
      }

      const command = commands.get(interaction.commandName);
      if (!command) return;
      await command.execute(interaction);
      return;
    }

    if (interaction.isModalSubmit()) {
      for (const cmd of commands.values()) {
        if (typeof cmd.handleModal === "function") {
          await cmd.handleModal(interaction);
        }
      }
      return;
    }

    if (interaction.isButton()) {
      const cid = interaction.customId || "";

      // Built-in watch toggles (project has these)
      if (cid.startsWith("watch:toggle:")) {
        const nationId = Number(cid.split(":")[2] || 0);
        if (!Number.isFinite(nationId) || nationId <= 0) {
          await interaction.reply({
            content: "Invalid nation id.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const uid = interaction.user.id;
        const gid = interaction.guildId!;
        const gs = await getGuildSettings(gid);

        const exists = await (async () => {
          const { rows } = await query(
            "SELECT 1 FROM watchlist WHERE discord_user_id=$1 AND nation_id=$2",
            [uid, nationId],
          );
          return rows.length > 0;
        })();

        if (exists) {
          await removeWatch(uid, nationId);
          await interaction.reply({
            content: `🔕 Removed **#${nationId}** from your watchlist.`,
            flags: MessageFlags.Ephemeral,
          });
        } else {
          await addOrUpdateWatch(uid, nationId, { dm_enabled: gs.dm_default });
          await interaction.reply({
            content: `🔔 Watching **#${nationId}**. DMs ${
              gs.dm_default ? "enabled" : "disabled"
            } by default.`,
            flags: MessageFlags.Ephemeral,
          });
        }
        return;
      }

      // Delegate to commands
      for (const cmd of commands.values()) {
        if (typeof cmd.handleButton === "function") {
          try {
            const handled = await cmd.handleButton(interaction);
            if (handled) return;
          } catch {
            // let other handlers try
          }
        }
      }
    }
  } catch (e) {
    console.error("interaction error:", e);
    try {
      if (
        interaction.isRepliable() &&
        !interaction.replied &&
        !interaction.deferred
      ) {
        await interaction.reply({
          content: "⚠️ Error executing action.",
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch {}
  }
});

loadCommands();
client.login(token);

process.on("SIGINT", () => {
  console.log("Shutting down…");
  client.destroy();
  process.exit(0);
});
process.on("SIGTERM", () => {
  console.log("Shutting down…");
  client.destroy();
  process.exit(0);
});
