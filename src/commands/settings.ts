import {
  SlashCommandBuilder,
  ChannelType,
  PermissionFlagsBits,
  type ChatInputCommandInteraction
} from "discord.js";
import type { Command } from "../types/command.js";
import { query } from "../data/db.js";

const data = new SlashCommandBuilder()
  .setName("settings")
  .setDescription("Configure alerts and behavior for this server")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand(sc =>
    sc
      .setName("deposits_channel")
      .setDescription("Set the channel for Large Deposit alerts")
      .addChannelOption(o =>
        o
          .setName("channel")
          .setDescription("Target text channel")
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(true)
      )
  )
  .addSubcommand(sc =>
    sc
      .setName("deposits_enable")
      .setDescription("Enable or disable Large Deposit alerts")
      .addStringOption(o =>
        o
          .setName("value")
          .setDescription("on/off")
          .addChoices({ name: "on", value: "on" }, { name: "off", value: "off" })
          .setRequired(true)
      )
  )
  .addSubcommand(sc =>
    sc
      .setName("alerts_dm")
      .setDescription("DM in-range raiders when alerts fire")
      .addStringOption(o =>
        o
          .setName("value")
          .setDescription("on/off")
          .addChoices({ name: "on", value: "on" }, { name: "off", value: "off" })
          .setRequired(true)
      )
  )
  .addSubcommand(sc =>
    sc
      .setName("alerts_mention")
      .setDescription("Mention a role on alerts (or turn off)")
      .addRoleOption(o =>
        o.setName("role").setDescription("Role to mention").setRequired(false)
      )
      .addStringOption(o =>
        o
          .setName("off")
          .setDescription("type 'off' to clear")
          .setRequired(false)
      )
  )
  .addSubcommand(sc =>
    sc
      .setName("range_near")
      .setDescription("Set Near-Range percentage outside declare window")
      .addIntegerOption(o =>
        o
          .setName("percent")
          .setDescription("e.g., 5")
          .setMinValue(1)
          .setMaxValue(50)
          .setRequired(true)
      )
  );

const execute = async (interaction: ChatInputCommandInteraction) => {
  const gid = interaction.guildId!;
  const sub = interaction.options.getSubcommand(true);

  if (sub === "deposits_channel") {
    const ch = interaction.options.getChannel("channel", true);
    const id = ch?.id || null;

    // verify bot can send there
    const tc = await interaction.client.channels.fetch(id!).catch(() => null);
    if (!tc || !("send" in tc)) {
      await interaction.reply({ content: "I can’t post in that channel.", ephemeral: true });
      return;
    }
    await query(
      "INSERT INTO guild_settings (guild_id, deposits_channel_id) VALUES ($1,$2) ON CONFLICT (guild_id) DO UPDATE SET deposits_channel_id=$2",
      [gid, id]
    );
    await interaction.reply({ content: "Deposits channel set.", ephemeral: true });

  } else if (sub === "deposits_enable") {
    const v = interaction.options.getString("value", true) === "on";
    await query(
      "INSERT INTO guild_settings (guild_id, deposits_enabled) VALUES ($1,$2) ON CONFLICT (guild_id) DO UPDATE SET deposits_enabled=$2",
      [gid, v]
    );
    await interaction.reply({ content: `Deposits alerts ${v ? "enabled" : "disabled"}.`, ephemeral: true });

  } else if (sub === "alerts_dm") {
    const v = interaction.options.getString("value", true) === "on";
    await query(
      "INSERT INTO guild_settings (guild_id, alerts_dm) VALUES ($1,$2) ON CONFLICT (guild_id) DO UPDATE SET alerts_dm=$2",
      [gid, v]
    );
    await interaction.reply({ content: `DMs on alert ${v ? "enabled" : "disabled"}.`, ephemeral: true });

  } else if (sub === "alerts_mention") {
    const role = interaction.options.getRole("role");
    const turnOff = (interaction.options.getString("off") || "").toLowerCase() === "off";
    const roleId = turnOff ? null : (role?.id ?? null);
    await query(
      "INSERT INTO guild_settings (guild_id, alerts_role_id) VALUES ($1,$2) ON CONFLICT (guild_id) DO UPDATE SET alerts_role_id=$2",
      [gid, roleId]
    );
    await interaction.reply({ content: roleId ? "Role mention set." : "Role mention cleared.", ephemeral: true });

  } else if (sub === "range_near") {
    const pct = interaction.options.getInteger("percent", true);
    await query(
      "INSERT INTO guild_settings (guild_id, near_range_pct) VALUES ($1,$2) ON CONFLICT (guild_id) DO UPDATE SET near_range_pct=$2",
      [gid, pct]
    );
    await interaction.reply({ content: `Near-Range set to ${pct}%`, ephemeral: true });
  }
};

const command: Command = { data, execute };
export default command;
