import {
  SlashCommandBuilder,
  ChannelType,
  PermissionFlagsBits,
  MessageFlags,
  type ChatInputCommandInteraction
} from "discord.js";
import type { Command } from "../types/command.js";
import { query } from "../data/db.js";

const data = new SlashCommandBuilder()
  .setName("settings")
  .setDescription("Configure alerts and behavior for this server")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)

  // legacy quick controls (still useful)
  .addSubcommand(sc =>
    sc.setName("deposits_channel")
      .setDescription("Set the legacy deposits channel (kept for compatibility)")
      .addChannelOption(o => o.setName("channel").setDescription("Text channel").addChannelTypes(ChannelType.GuildText).setRequired(true))
  )
  .addSubcommand(sc =>
    sc.setName("alerts_dm")
      .setDescription("DM linked raiders on alerts")
      .addStringOption(o => o.setName("value").setDescription("on/off").addChoices({name:"on",value:"on"},{name:"off",value:"off"}).setRequired(true))
  )
  .addSubcommand(sc =>
    sc.setName("alerts_mention")
      .setDescription("Mention a role on alerts (or turn off)")
      .addRoleOption(o => o.setName("role").setDescription("Role to mention").setRequired(false))
      .addStringOption(o => o.setName("off").setDescription("type 'off' to clear").setRequired(false))
  )
  .addSubcommand(sc =>
    sc.setName("range_near")
      .setDescription("Set Near-Range percentage outside declare window")
      .addIntegerOption(o => o.setName("percent").setDescription("e.g., 5").setMinValue(1).setMaxValue(50).setRequired(true))
  )

  // radar group
  .addSubcommandGroup(g =>
    g.setName("radar").setDescription("Radar channels & thresholds")
      .addSubcommand(sc =>
        sc.setName("bank_channel").setDescription("Set the Bank Radar feed channel")
          .addChannelOption(o => o.setName("channel").setDescription("Text channel").addChannelTypes(ChannelType.GuildText).setRequired(true))
      )
      .addSubcommand(sc =>
        sc.setName("beige_channel").setDescription("Set the Beige Radar feed channel")
          .addChannelOption(o => o.setName("channel").setDescription("Text channel").addChannelTypes(ChannelType.GuildText).setRequired(true))
      )
      .addSubcommand(sc =>
        sc.setName("bank_abs_usd").setDescription("Set the global big-deposit USD floor")
          .addIntegerOption(o => o.setName("amount").setDescription("e.g., 10000000").setRequired(true))
      )
      .addSubcommand(sc =>
        sc.setName("bank_rel_pct").setDescription("Set the global big-deposit % vs loot p50 (future)")
          .addIntegerOption(o => o.setName("percent").setDescription("e.g., 20").setMinValue(1).setMaxValue(100).setRequired(true))
      )
      .addSubcommand(sc =>
        sc.setName("inrange_only").setDescription("Only post to channel if someone here is in/near-range")
          .addStringOption(o => o.setName("value").setDescription("on/off").addChoices({name:"on",value:"on"},{name:"off",value:"off"}).setRequired(true))
      )
      .addSubcommand(sc =>
        sc.setName("dm_default").setDescription("Default DM behavior when someone taps 🔔")
          .addStringOption(o => o.setName("value").setDescription("on/off").addChoices({name:"on",value:"on"},{name:"off",value:"off"}).setRequired(true))
      )
      .addSubcommand(sc =>
        sc.setName("poll_ms").setDescription("Set radar poll cadence in ms")
          .addIntegerOption(o => o.setName("ms").setDescription("e.g., 90000").setMinValue(15000).setMaxValue(600000).setRequired(true))
      )
  );

const execute = async (interaction: ChatInputCommandInteraction) => {
  const gid = interaction.guildId!;
  const group = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand(true);

  if (!group) {
    if (sub === "deposits_channel") {
      const ch = interaction.options.getChannel("channel", true);
      await query("INSERT INTO guild_settings (guild_id, deposits_channel_id) VALUES ($1,$2) ON CONFLICT (guild_id) DO UPDATE SET deposits_channel_id=$2", [gid, ch.id]);
      await interaction.reply({ content: "Deposits channel set.", flags: MessageFlags.Ephemeral }); return;
    }
    if (sub === "alerts_dm") {
      const v = interaction.options.getString("value", true) === "on";
      await query("INSERT INTO guild_settings (guild_id, alerts_dm) VALUES ($1,$2) ON CONFLICT (guild_id) DO UPDATE SET alerts_dm=$2", [gid, v]);
      await interaction.reply({ content: `DMs on alert ${v ? "enabled" : "disabled"}.`, flags: MessageFlags.Ephemeral }); return;
    }
    if (sub === "alerts_mention") {
      const role = interaction.options.getRole("role");
      const off = (interaction.options.getString("off") || "").toLowerCase() === "off";
      const roleId = off ? null : (role?.id ?? null);
      await query("INSERT INTO guild_settings (guild_id, alerts_role_id) VALUES ($1,$2) ON CONFLICT (guild_id) DO UPDATE SET alerts_role_id=$2", [gid, roleId]);
      await interaction.reply({ content: roleId ? "Role mention set." : "Role mention cleared.", flags: MessageFlags.Ephemeral }); return;
    }
    if (sub === "range_near") {
      const pct = interaction.options.getInteger("percent", true);
      await query("INSERT INTO guild_settings (guild_id, near_range_pct) VALUES ($1,$2) ON CONFLICT (guild_id) DO UPDATE SET near_range_pct=$2", [gid, pct]);
      await interaction.reply({ content: `Near-Range set to ${pct}%`, flags: MessageFlags.Ephemeral }); return;
    }
    return;
  }

  // radar group
  if (group === "radar") {
    if (sub === "bank_channel") {
      const ch = interaction.options.getChannel("channel", true);
      await query("INSERT INTO guild_settings (guild_id, bank_radar_channel_id) VALUES ($1,$2) ON CONFLICT (guild_id) DO UPDATE SET bank_radar_channel_id=$2", [gid, ch.id]);
      await interaction.reply({ content: "Bank Radar channel set.", flags: MessageFlags.Ephemeral }); return;
    }
    if (sub === "beige_channel") {
      const ch = interaction.options.getChannel("channel", true);
      await query("INSERT INTO guild_settings (guild_id, beige_radar_channel_id) VALUES ($1,$2) ON CONFLICT (guild_id) DO UPDATE SET beige_radar_channel_id=$2", [gid, ch.id]);
      await interaction.reply({ content: "Beige Radar channel set.", flags: MessageFlags.Ephemeral }); return;
    }
    if (sub === "bank_abs_usd") {
      const amt = interaction.options.getInteger("amount", true);
      await query("INSERT INTO guild_settings (guild_id, bank_abs_usd) VALUES ($1,$2) ON CONFLICT (guild_id) DO UPDATE SET bank_abs_usd=$2", [gid, amt]);
      await interaction.reply({ content: `Bank floor set to $${fmt(amt)}.`, flags: MessageFlags.Ephemeral }); return;
    }
    if (sub === "bank_rel_pct") {
      const pct = interaction.options.getInteger("percent", true);
      await query("INSERT INTO guild_settings (guild_id, bank_rel_pct) VALUES ($1,$2) ON CONFLICT (guild_id) DO UPDATE SET bank_rel_pct=$2", [gid, pct]);
      await interaction.reply({ content: `Bank relative floor set to ${pct}%.`, flags: MessageFlags.Ephemeral }); return;
    }
    if (sub === "inrange_only") {
      const v = interaction.options.getString("value", true) === "on";
      await query("INSERT INTO guild_settings (guild_id, inrange_only) VALUES ($1,$2) ON CONFLICT (guild_id) DO UPDATE SET inrange_only=$2", [gid, v]);
      await interaction.reply({ content: `Channel posts will ${v ? "" : "not "}require an in/near-range raider.`, flags: MessageFlags.Ephemeral }); return;
    }
    if (sub === "dm_default") {
      const v = interaction.options.getString("value", true) === "on";
      await query("INSERT INTO guild_settings (guild_id, dm_default) VALUES ($1,$2) ON CONFLICT (guild_id) DO UPDATE SET dm_default=$2", [gid, v]);
      await interaction.reply({ content: `Default DM on 🔔 is now ${v ? "on" : "off"}.`, flags: MessageFlags.Ephemeral }); return;
    }
    if (sub === "poll_ms") {
      const ms = interaction.options.getInteger("ms", true);
      await query("INSERT INTO guild_settings (guild_id, radar_poll_ms) VALUES ($1,$2) ON CONFLICT (guild_id) DO UPDATE SET radar_poll_ms=$2", [gid, ms]);
      await interaction.reply({ content: `Radar cadence set to ${ms} ms.`, flags: MessageFlags.Ephemeral }); return;
    }
  }
};

function fmt(n: number) { return Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n); }

const command: Command = { data, execute };
export default command;
