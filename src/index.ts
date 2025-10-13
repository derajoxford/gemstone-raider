import "dotenv/config";
import { Client, Collection, Events, GatewayIntentBits, REST, Routes, type ChatInputCommandInteraction } from "discord.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCommandsFrom } from "./core/registry.js";
import type { Command } from "./types/command.js";

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error("DISCORD_TOKEN missing. Is /etc/pnw-raider.env loaded by systemd?");
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const commands = new Collection<string, Command>();

// Load commands from dist/commands at runtime
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const commandsDir = path.resolve(__dirname, "commands");

async function loadAll() {
  const list = await loadCommandsFrom(commandsDir);
  for (const c of list) commands.set(c.data.name, c);
  console.log(`Loaded ${commands.size} command(s).`);
}

client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const cmd = commands.get(interaction.commandName);
  if (!cmd) return;
  try {
    await cmd.execute(interaction as ChatInputCommandInteraction);
  } catch (err) {
    console.error(err);
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: "⚠️ Error executing command.", ephemeral: true }).catch(() => {});
    } else {
      await interaction.reply({ content: "⚠️ Error executing command.", ephemeral: true }).catch(() => {});
    }
  }
});

await loadAll();
client.login(token);

// Graceful
process.on("unhandledRejection", (e) => console.error("UNHANDLED REJECTION", e));
process.on("uncaughtException", (e) => console.error("UNCAUGHT EXCEPTION", e));
