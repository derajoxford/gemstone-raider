import type { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";

export interface Command {
  data: SlashCommandBuilder;
  disabled?: boolean;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}
