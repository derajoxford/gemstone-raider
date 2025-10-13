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
  const { rows } = await query<{
    deposits_channel_id: string | null,
    deposits_enabled: boolean | null,
    alerts_dm: boolean | null,
    alerts_role_id: string | null
  }>(`SELECT deposits_channel_id, deposits_enabled, alerts_dm, alerts_role_id
      FROM guild_settings WHERE guild_id=$1`, [gid]);

  const gs = rows[0] || {};
  if (gs.deposits_enabled === false) {
    await interaction.reply({ content: "Deposits alerts are disabled for this server.", ephemeral: true });
    return;
  }

  const channelId = gs.deposits_channel_id || process.env.DEPOSITS_CHANNEL_ID || null;
  if (!channelId) { await interaction.reply({ content: "No deposits channel set. Use /settings deposits_channel.", ephemeral: true }); return; }

  const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
  if (!channel || !("send" in channel)) { await interaction.reply({ content: "Bot cannot post in the configured channel.", ephemeral: true }); return; }

  // Optional role mention
  const mention = gs.alerts_role_id ? `<@&${gs.alerts_role_id}> ` : "";

  const payload = depositAlertEmbed({
    nationId: 123456, nationName: "TargetNation",
    senderId: 445566, senderName: "BankerNation",
    notionalUSD: 9400000,
    breakdown: "$7.2m cash • 20k food • 3k munitions",
    whenText: "just now"
  });

  // @ts-ignore
  await channel.send({ content: mention || undefined, ...payload });

  // Optional DM test (DM the command invoker)
  if (gs.alerts_dm) {
    await interaction.user.send(payload).catch(() => null);
  }

  await interaction.reply({ content: "Sent sample deposit alert.", ephemeral: true });
};

const command: Command = { data, execute };
export default command;
