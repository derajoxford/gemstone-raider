// src/commands/registered.ts
import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";
import type { Command } from "../types/command.js";
import { query } from "../data/db.js";

const data = new SlashCommandBuilder()
  .setName("registered")
  .setDescription("Admin: list all users registered with Raider (/link_nation).")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

const execute = async (interaction: ChatInputCommandInteraction) => {
  if (!interaction.guild) {
    await interaction.reply({
      content: "This command can only be used in a server.",
      ephemeral: true,
    });
    return;
  }

  // Extra safety check in case Discord permissions are weird
  if (
    !interaction.memberPermissions ||
    !interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)
  ) {
    await interaction.reply({
      content: "You need the **Manage Server** permission to use this command.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  let rows: { discord_user_id: string; nation_id: number }[] = [];
  try {
    const res = await query<{ discord_user_id: string; nation_id: number }>(
      `
      SELECT discord_user_id, nation_id
      FROM user_nation
      WHERE is_primary = true
      ORDER BY discord_user_id
      `,
      [],
    );
    rows = res.rows;
  } catch (err) {
    console.error("[registered] failed to query user_nation", err);
    await interaction.editReply({
      content: "❌ Failed to fetch registered users. Check the bot logs.",
    });
    return;
  }

  if (rows.length === 0) {
    await interaction.editReply({
      content: "Nobody is currently registered with Raider (/link_nation).",
    });
    return;
  }

  const MAX_ENTRIES = 100; // keep output sane
  const limited = rows.slice(0, MAX_ENTRIES);

  const lines = limited.map((row) => {
    const mention = `<@${row.discord_user_id}>`;
    return `• ${mention} → nation **#${row.nation_id}** (primary)`;
  });

  const moreNote =
    rows.length > MAX_ENTRIES
      ? `\n\nShowing first ${MAX_ENTRIES} of ${rows.length} registered users.`
      : "";

  await interaction.editReply({
    content: `**Registered Raider users (primary links):**\n\n${lines.join(
      "\n",
    )}${moreNote}`,
  });
};

const command: Command = { data, execute };
export default command;
