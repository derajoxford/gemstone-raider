import { SlashCommandBuilder, type ChatInputCommandInteraction, PermissionFlagsBits } from "discord.js";
import type { Command } from "../types/command.js";
import { query } from "../data/db.js";

const data = new SlashCommandBuilder()
  .setName("link_nation")
  .setDescription("Link your Discord user to a PnW nation ID for range intel.")
  .addStringOption(o => o.setName("nation_id").setDescription("Your PnW nation ID").setRequired(true));

const execute = async (interaction: ChatInputCommandInteraction) => {
  const nationIdStr = interaction.options.getString("nation_id", true).trim();
  const nationId = Number(nationIdStr);
  if (!Number.isFinite(nationId) || nationId <= 0) {
    await interaction.reply({ content: "Invalid nation ID.", ephemeral: true });
    return;
  }

  // demote any existing primary, then upsert this one as primary
  await query(
    `UPDATE user_nation SET is_primary=false WHERE discord_user_id=$1 AND is_primary=true`,
    [interaction.user.id]
  );
  await query(
    `INSERT INTO user_nation (discord_user_id, nation_id, is_primary)
     VALUES ($1,$2,true)
     ON CONFLICT (discord_user_id, nation_id)
     DO UPDATE SET is_primary=true`,
    [interaction.user.id, nationId]
  );

  await interaction.reply({ content: `Linked **${interaction.user.username}** → nation **#${nationId}** (primary).`, ephemeral: true });
};

const command: Command = { data, execute };
export default command;
