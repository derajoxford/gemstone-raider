import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { depositAlertEmbed } from "./embeds.js";

export function bankRowWithWatch(nationId: number) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`watch:toggle:${nationId}`)
      .setLabel("🔔 Notify me")
      .setStyle(ButtonStyle.Primary)
  );
}

export function beigeSoonEmbed(opts: {
  nationId: number;
  nationName: string;
  exitsInMin: number;        // approximate
  offSlotsOpen: number;
  defSlotsOpen: number;
  lastActiveMin?: number | null;
  nearPct: number;
  statusText?: string;
}) {
  const e = new EmbedBuilder()
    .setColor(0xeab308)
    .setTitle(`🧱 Beige ending soon: ${opts.nationName} (#${opts.nationId})`)
    .setDescription([
      `Exits beige in **~${opts.exitsInMin}m**`,
      `Slots — Off: **${opts.offSlotsOpen}/3**, Def: **${opts.defSlotsOpen}/3**`,
      opts.lastActiveMin != null ? `Last active **${fmtTime(opts.lastActiveMin)}** ago` : null,
      opts.statusText ? opts.statusText : null
    ].filter(Boolean).join("\n"))
    .setTimestamp(new Date());
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setLabel("Open Nation").setStyle(ButtonStyle.Link).setURL(nationUrl(opts.nationId)),
    new ButtonBuilder().setLabel("Declare War").setStyle(ButtonStyle.Link).setURL(warUrl(opts.nationId)),
    new ButtonBuilder().setCustomId(`watch:toggle:${opts.nationId}`).setLabel("🔔 Notify me").setStyle(ButtonStyle.Primary)
  );
  return { embeds: [e], components: [row] };
}

export function slotOpenEmbed(opts: {
  nationId: number;
  nationName: string;
  offOpen: number;
  defOpen: number;
}) {
  const e = new EmbedBuilder()
    .setColor(0x22c55e)
    .setTitle(`🎟️ Slot open: ${opts.nationName} (#${opts.nationId})`)
    .setDescription(`Off: **${opts.offOpen}/3** • Def: **${opts.defOpen}/3**`)
    .setTimestamp(new Date());
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setLabel("Open Nation").setStyle(ButtonStyle.Link).setURL(nationUrl(opts.nationId)),
    new ButtonBuilder().setLabel("Declare War").setStyle(ButtonStyle.Link).setURL(warUrl(opts.nationId)),
    new ButtonBuilder().setCustomId(`watch:toggle:${opts.nationId}`).setLabel("🔔 Notify me").setStyle(ButtonStyle.Primary)
  );
  return { embeds: [e], components: [row] };
}

function nationUrl(id: number) { return "https://politicsandwar.com/nation/id=" + id; }
function warUrl(id: number) { return "https://politicsandwar.com/nation/war/declare/id=" + id; }
function fmtTime(m: number) {
  if (m < 60) return `${m}m`;
  const h = Math.floor(m/60), r = m % 60;
  return `${h}h ${r}m`;
}
