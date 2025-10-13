import { SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import type { Command } from "../types/command.js";

const data = new SlashCommandBuilder()
  .setName("ping")
  .setDescription("Health check — returns Pong with shard time.");

const execute = async (interaction: ChatInputCommandInteraction) => {
  const now = Date.now();
  await interaction.reply({ content: `🏴‍☠️ Pong — ${now}`, ephemeral: true });
};

const command: Command = { data, execute };
export default command;
