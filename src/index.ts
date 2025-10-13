import "dotenv/config";
import { Client, Collection, GatewayIntentBits, Interaction, MessageFlags } from "discord.js";
import fs from "node:fs";
import path from "node:path";
import type { Command } from "./types/command.js";
import { startAidPoller } from "./jobs/poll_aid.js";
import { startWatchRadar } from "./jobs/radar_watch.js";
import { addOrUpdateWatch, removeWatch } from "./data/watch.js";
import { getGuildSettings } from "./data/settings.js";

const token = process.env.DISCORD_TOKEN!;
const appId = process.env.DISCORD_APP_ID!;
if (!token || !appId) throw new Error("Missing DISCORD_TOKEN or DISCORD_APP_ID");

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

const commands = new Collection<string, Command>();
const commandsPath = path.join(process.cwd(), "dist", "commands");
fs.readdirSync(commandsPath).filter(f => f.endsWith(".js")).forEach(file => {
  const mod = require(path.join(commandsPath, file));
  const cmd: Command = mod.default;
  if (!cmd?.data?.name || typeof cmd.execute !== "function") return;
  commands.set(cmd.data.name, cmd);
});
console.log(`Loaded ${commands.size} command(s).`);

client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user?.tag}`);

  // start jobs
  startAidPoller(client);
  startWatchRadar(client);
});

client.on("interactionCreate", async (interaction: Interaction) => {
  try {
    // slash commands
    if (interaction.isChatInputCommand()) {
      const command = commands.get(interaction.commandName);
      if (!command) return;
      await command.execute(interaction as any);
      return;
    }

    // buttons (🔔 Notify me)
    if (interaction.isButton()) {
      const cid = interaction.customId || "";
      if (cid.startsWith("watch:toggle:")) {
        const nationId = Number(cid.split(":")[2] || 0);
        if (!Number.isFinite(nationId) || nationId <= 0) {
          await interaction.reply({ content: "Invalid nation id.", flags: MessageFlags.Ephemeral });
          return;
        }
        const uid = interaction.user.id;
        // toggle: if exists → remove; else add with guild default DM
        const gid = interaction.guildId!;
        const gs = await getGuildSettings(gid);
        // Quick check if exists
        const exists = await (async () => {
          const { rows } = await require("./data/db.js").query(`SELECT 1 FROM watchlist WHERE discord_user_id=$1 AND nation_id=$2`, [uid, nationId]);
          return rows.length > 0;
        })();

        if (exists) {
          await removeWatch(uid, nationId);
          await interaction.reply({ content: `🔕 Removed **#${nationId}** from your watchlist.`, flags: MessageFlags.Ephemeral });
        } else {
          await addOrUpdateWatch(uid, nationId, { dm_enabled: gs.dm_default });
          await interaction.reply({ content: `🔔 Watching **#${nationId}**. DMs ${gs.dm_default ? "enabled" : "disabled"} by default.`, flags: MessageFlags.Ephemeral });
        }
        return;
      }
    }
  } catch (e) {
    console.error("interaction error:", e);
    // best-effort reply
    if (interaction.isRepliable()) {
      try { await interaction.reply({ content: "⚠️ Error executing action.", flags: MessageFlags.Ephemeral }); } catch {}
    }
  }
});

client.login(token);
