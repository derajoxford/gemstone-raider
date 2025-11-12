// src/types/command.ts
import type {
  SlashCommandBuilder,
  SlashCommandSubcommandsOnlyBuilder,
  ChatInputCommandInteraction,
  ButtonInteraction,
  ModalSubmitInteraction,
} from "discord.js";

export type Command = {
  // Accept either plain builder or the subcommands-only builder
  data: SlashCommandBuilder | SlashCommandSubcommandsOnlyBuilder;

  // Required: slash command entry
  execute(i: ChatInputCommandInteraction): Promise<void>;

  // Optional: component handlers
  handleButton?(i: ButtonInteraction): Promise<boolean>;
  handleModal?(i: ModalSubmitInteraction): Promise<boolean>;
};
