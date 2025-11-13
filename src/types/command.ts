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

  // Optional routers used by some commands
  handleModal?: (interaction: ModalSubmitInteraction) => Promise<any>;
  handleButton?: (i: ButtonInteraction) => Promise<boolean>;

  // Registry supports disabled flag; keep type happy
  disabled?: boolean;
};
