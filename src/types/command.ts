// src/types/command.ts
import {
  ButtonInteraction,
  ChatInputCommandInteraction,
  ModalSubmitInteraction,
  SlashCommandBuilder,
  SlashCommandSubcommandsOnlyBuilder,
  SlashCommandOptionsOnlyBuilder,
} from "discord.js";

export type Command = {
  // Allow all three builder shapes so simple commands (no subcommands)
  // that infer SlashCommandOptionsOnlyBuilder compile cleanly.
  data:
    | SlashCommandBuilder
    | SlashCommandSubcommandsOnlyBuilder
    | SlashCommandOptionsOnlyBuilder;

  execute: (interaction: ChatInputCommandInteraction) => Promise<any>;
  handleModal?: (interaction: ModalSubmitInteraction) => Promise<any>;

  // Return true if handled, false to allow other handlers to try
  handleButton?: (i: ButtonInteraction) => Promise<boolean>;

  // Registry may check this
  disabled?: boolean;
};
