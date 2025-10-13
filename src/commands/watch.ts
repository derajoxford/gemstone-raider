import { SlashCommandBuilder, MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import type { Command } from "../types/command.js";
import { addOrUpdateWatch, removeWatch, listWatches } from "../data/watch.js";
import { fetchNationMap } from "../pnw/nations.js";

const data = new SlashCommandBuilder()
  .setName("watch")
  .setDescription("Manage your watchlist & DM alerts")
  .addSubcommand(sc =>
    sc.setName("add").setDescription("Add a nation to your watchlist")
      .addStringOption(o => o.setName("nation_id").setDescription("Nation ID").setRequired(true))
  )
  .addSubcommand(sc =>
    sc.setName("rm").setDescription("Remove a nation from your watchlist")
      .addStringOption(o => o.setName("nation_id").setDescription("Nation ID").setRequired(true))
  )
  .addSubcommand(sc =>
    sc.setName("list").setDescription("View your watchlist")
  )
  .addSubcommand(sc =>
    sc.setName("options").setDescription("Per-nation options")
      .addStringOption(o => o.setName("nation_id").setDescription("Nation ID").setRequired(true))
      .addIntegerOption(o => o.setName("bank_abs").setDescription("DM if deposit ≥ this USD amount"))
      .addIntegerOption(o => o.setName("bank_rel").setDescription("DM if deposit ≥ this % of loot p50"))
      .addIntegerOption(o => o.setName("beige_early").setDescription("Minutes before beige exit to DM"))
      .addStringOption(o => o.setName("dm").setDescription("Enable DMs").addChoices({name:"on",value:"on"},{name:"off",value:"off"}))
      .addStringOption(o => o.setName("inrange").setDescription("Only DM if you’re in/near-range").addChoices({name:"on",value:"on"},{name:"off",value:"off"}))
  );

const execute = async (interaction: ChatInputCommandInteraction) => {
  const sub = interaction.options.getSubcommand(true);
  const me = interaction.user.id;

  if (sub === "add") {
    const id = Number(interaction.options.getString("nation_id", true));
    if (!Number.isFinite(id) || id <= 0) { await interaction.reply({ content: "Invalid nation ID.", flags: MessageFlags.Ephemeral }); return; }
    await addOrUpdateWatch(me, id, {});
    const names = await fetchNationMap([id]).catch(() => ({} as any));
    await interaction.reply({ content: `🔔 Watching **${names[id]?.name ?? "Nation"}** (#${id}). DMs are **on** by default.`, flags: MessageFlags.Ephemeral });
    return;
  }

  if (sub === "rm") {
    const id = Number(interaction.options.getString("nation_id", true));
    if (!Number.isFinite(id) || id <= 0) { await interaction.reply({ content: "Invalid nation ID.", flags: MessageFlags.Ephemeral }); return; }
    await removeWatch(me, id);
    await interaction.reply({ content: `🔕 Removed **#${id}** from your watchlist.`, flags: MessageFlags.Ephemeral });
    return;
  }

  if (sub === "list") {
    const rows = await listWatches(me);
    if (!rows.length) { await interaction.reply({ content: "You’re not watching any nations yet.", flags: MessageFlags.Ephemeral }); return; }
    const ids = rows.map(r => r.nation_id);
    const map = await fetchNationMap(ids).catch(() => ({} as any));
    const lines = rows.map(r => {
      const name = map[r.nation_id]?.name ?? "Nation";
      const flags = [
        r.dm_enabled ? "DM:on" : "DM:off",
        r.inrange_only ? "in/near-range" : null,
        r.bank_abs_usd ? `$≥${fmt(r.bank_abs_usd)}` : null,
        r.beige_early_min ? `beige-${r.beige_early_min}m` : null
      ].filter(Boolean).join(" · ");
      return `• **${name}** (#${r.nation_id}) — ${flags || "defaults"}`;
    });
    await interaction.reply({ content: `Your watchlist:\n${lines.join("\n")}`, flags: MessageFlags.Ephemeral });
    return;
  }

  if (sub === "options") {
    const id = Number(interaction.options.getString("nation_id", true));
    if (!Number.isFinite(id) || id <= 0) { await interaction.reply({ content: "Invalid nation ID.", flags: MessageFlags.Ephemeral }); return; }
    const opts: any = {};
    const bankAbs = interaction.options.getInteger("bank_abs"); if (bankAbs != null) opts.bank_abs_usd = bankAbs;
    const bankRel = interaction.options.getInteger("bank_rel"); if (bankRel != null) opts.bank_rel_pct = bankRel;
    const early   = interaction.options.getInteger("beige_early"); if (early != null) opts.beige_early_min = early;
    const dm      = interaction.options.getString("dm"); if (dm) opts.dm_enabled = dm === "on";
    const inrange = interaction.options.getString("inrange"); if (inrange) opts.inrange_only = inrange === "on";

    await addOrUpdateWatch(me, id, opts);
    await interaction.reply({ content: `⚙️ Updated watch options for #${id}.`, flags: MessageFlags.Ephemeral });
    return;
  }
};

function fmt(n: number) { return Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n); }

const command: Command = { data, execute };
export default command;
