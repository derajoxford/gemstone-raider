import type { ChatInputCommandInteraction } from "discord.js";

/**
 * Keep this liberal so both simple commands and subcommand-based builders work.
 * We accept any slash-like builder object that has .toJSON() at register time.
 */
export interface Command {
  // Using 'any' here avoids TS friction between SlashCommandBuilder vs
  // SlashCommandSubcommandsOnlyBuilder across discord.js/@discordjs/builders.
  data: any;
  disabled?: boolean;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}
