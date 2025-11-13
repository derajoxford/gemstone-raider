// src/types/command.ts
import {
  ButtonInteraction,
  ChatInputCommandInteraction,
  ModalSubmitInteraction,
  SlashCommandBuilder,
  SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";

export type Command = {
  data: SlashCommandBuilder | SlashCommandSubcommandsOnlyBuilder;
  execute: (interaction: ChatInputCommandInteraction) => Promise<any>;
  handleModal?: (interaction: ModalSubmitInteraction) => Promise<any>;
  // Return true if handled, false to allow other handlers to try
  handleButton?: (i: ButtonInteraction) => Promise<boolean>;
  // Registry may check this
  disabled?: boolean;
};
