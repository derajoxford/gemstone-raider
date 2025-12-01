// src/commands/admin_register.ts
import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  PermissionFlagsBits,
  User,
} from "discord.js";
import type { Command } from "../types/command.js";
import { query } from "../data/db.js";

const data = new SlashCommandBuilder()
  .setName("admin_register")
  .setDescription("Admin: link a Discord user to a PnW nation ID (primary).")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addUserOption((opt) =>
    opt
      .setName("user")
      .setDescription("Discord user to link")
      .setRequired(true),
  )
  .addStringOption((opt) =>
    opt
      .setName("nation_id")
      .setDescription("PnW nation ID to link as primary")
      .setRequired(true),
  );

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

  const targetUser = interaction.options.getUser("user", true) as User;
  const nationIdStr = interaction.options.getString("nation_id", true).trim();
  const nationId = Number(nationIdStr);

  if (!Number.isFinite(nationId) || nationId <= 0) {
    await interaction.reply({
      content: "❌ Invalid nation ID. Please provide a positive number.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const discordUserId = targetUser.id;

  try {
    // Demote any existing primary link for this user
    await query(
      `
      UPDATE user_nation
      SET is_primary = false
      WHERE discord_user_id = $1
        AND is_primary = true
      `,
      [discordUserId],
    );

    // Upsert this nation as primary
    await query(
      `
      INSERT INTO user_nation (discord_user_id, nation_id, is_primary)
      VALUES ($1, $2, true)
      ON CONFLICT (discord_user_id, nation_id)
      DO UPDATE SET is_primary = true
      `,
      [discordUserId, nationId],
    );
  } catch (err) {
    console.error("[admin_register] failed to upsert user_nation", {
      discordUserId,
      nationId,
      err,
    });
    await interaction.editReply({
      content:
        "❌ Failed to register that user. Please check the bot logs for details.",
    });
    return;
  }

  const adminMention = `<@${interaction.user.id}>`;
  const targetMention = `<@${discordUserId}>`;

  await interaction.editReply({
    content: `✅ ${adminMention} linked ${targetMention} → nation **#${nationId}** as **primary**.\n\nThis will be used for Raider features like auto war rooms when that nation is defending.`,
  });
};

const command: Command = { data, execute };
export default command;
