import { SlashCommandBuilder, PermissionFlagsBits, type ChatInputCommandInteraction } from "discord.js";
import type { Command } from "../types/command.js";
import { query } from "../data/db.js";
import { depositAlertEmbed } from "../ui/embeds.js";

const data = new SlashCommandBuilder()
  .setName("test_deposit")
  .setDescription("Post a sample Large Deposit alert to the configured channel.")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

const execute = async (interaction: ChatInputCommandInteraction) => {
  const gid = interaction.guildId!;
  const { rows } = await query<{ deposits_channel_id: string | null }>(
    `SELECT deposits_channel_id FROM guild_settings WHERE guild_id=$1`,
    [gid]
  );
  const channelId = rows[0]?.deposits_channel_id || process.env.DEPOSITS_CHANNEL_ID;
  if (!channelId) {
    await interaction.reply({ content: "No deposits channel configured.", ephemeral: true });
    return;
  }
  const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
  if (!channel || !("send" in channel)) {
    await interaction.reply({ content: `Cannot access channel ${channelId}.`, ephemeral: true });
    return;
  }

  const payload = depositAlertEmbed({
    nationId: 123456,
    nationName: "TargetNation",
    senderId: 445566,
    senderName: "BankerNation",
    notionalUSD: 9400000,
    breakdown: "$7.2m cash • 20k food • 3k munitions",
    whenText: "just now"
  });

  // @ts-ignore - runtime check already done
  await channel.send(payload);
  await interaction.reply({ content: "Sent sample deposit alert.", ephemeral: true });
};

const command: Command = { data, execute };
export default command;
