import "dotenv/config";
import { Client, Collection, Events, GatewayIntentBits, type ChatInputCommandInteraction } from "discord.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCommandsFrom } from "./core/registry.js";
import type { Command } from "./types/command.js";
import { startAidPoller } from "./jobs/poll_aid.js"; // <-- add

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error("DISCORD_TOKEN missing. Is /etc/pnw-raider.env loaded by systemd or a .env present?");
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const commands = new Collection<string, Command>();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const commandsDir = path.resolve(__dirname, "commands");

async function loadAll() {
  const list = await loadCommandsFrom(commandsDir);
  for (const c of list) commands.set(c.data.name, c);
  console.log(`Loaded ${commands.size} command(s).`);
}

client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);
  startAidPoller(client);                // <-- add
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const cmd = commands.get(interaction.commandName);
  if (!cmd) return;
  try {
    await cmd.execute(interaction as ChatInputCommandInteraction);
  } catch (err) {
    console.error(err);
    const payload = { content: "⚠️ Error executing command.", ephemeral: true } as const;
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(payload).catch(() => {});
    } else {
      await interaction.reply(payload).catch(() => {});
    }
  }
});

await loadAll();
client.login(token);

process.on("unhandledRejection", (e) => console.error("UNHANDLED REJECTION", e));
process.on("uncaughtException", (e) => console.error("UNCAUGHT EXCEPTION", e));
