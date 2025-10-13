import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

export function depositAlertEmbed(opts: {
  nationId: number;
  nationName: string;
  senderId?: number;
  senderName?: string;
  notionalUSD: number;
  breakdown: string; // e.g., "$7.2m cash • 20k food • 3k munitions"
  whenText: string;  // e.g., "1m ago"
}) {
  const e = new EmbedBuilder()
    .setTitle(`Large Deposit: +$${fmtNum(opts.notionalUSD)} to ${opts.nationName} (#${opts.nationId})`)
    .setDescription(
      [
        opts.senderId && opts.senderName ? `**From:** ${opts.senderName} (#${opts.senderId})` : null,
        `**When:** ${opts.whenText}`,
        `**Breakdown:** ${opts.breakdown}`
      ].filter(Boolean).join("\n")
    )
    .setTimestamp(new Date());

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setLabel("Open Nation").setStyle(ButtonStyle.Link).setURL(nationUrl(opts.nationId)),
    new ButtonBuilder().setLabel("Open War Page").setStyle(ButtonStyle.Link).setURL(warUrl(opts.nationId))
  );

  return { embeds: [e], components: [row] };
}

function nationUrl(id: number) { return `https://politicsandwar.com/nation/id=${id}`; }
function warUrl(id: number) { return `https://politicsandwar.com/nation/war/declare/id=${id}`; }

function fmtNum(n: number) {
  return Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n);
}
