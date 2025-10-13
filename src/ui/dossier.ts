import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

export type DossierData = {
  target: { id: number; name: string; score: number | null };
  attacker?: { id: number; name?: string; score: number | null };
  nearPct: number;
  window: { min: number; max: number };          // declareable window (attackerScore * [0.75..2.5])
  status: { inRange: boolean; nearRange: boolean; deltaPct?: number; side?: "below" | "above" };
};

export function dossierEmbed(d: DossierData) {
  const e = new EmbedBuilder()
    .setTitle(`🎯 Dossier: ${d.target.name} (#${d.target.id})`)
    .setDescription([
      `**Target score:** ${fmtScore(d.target.score)}`,
      d.attacker ? `**Your score:** ${fmtScore(d.attacker.score)}` : null,
      d.attacker ? `**Declare window:** ${fmtScore(d.window.min)} – ${fmtScore(d.window.max)}` : null,
      "",
      statusLine(d)
    ].filter(Boolean).join("\n"))
    .setFooter({ text: `Near-range threshold: ${d.nearPct}%` });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setLabel("Open Nation").setStyle(ButtonStyle.Link).setURL(nationUrl(d.target.id)),
    new ButtonBuilder().setLabel("Declare War").setStyle(ButtonStyle.Link).setURL(warUrl(d.target.id))
  );

  return { embeds: [e], components: [row] };
}

function statusLine(d: DossierData) {
  if (d.attacker?.score == null || d.target.score == null) {
    return "⚠️ Missing score data to compute range.";
  }
  if (d.status.inRange) return "✅ **In Range** — you can declare now.";
  if (d.status.nearRange) {
    const side = d.status.side === "below" ? "below" : "above";
    const delta = typeof d.status.deltaPct === "number" ? `${Math.abs(d.status.deltaPct).toFixed(1)}%` : "?";
    return `🟡 **Near-Range** — ${delta} ${side} window (within ${d.nearPct}%).`;
  }
  return "❌ **Out of Range**.";
}

function fmtScore(n: number | null) {
  return n == null ? "—" : Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(n);
}
function nationUrl(id: number) { return "https://politicsandwar.com/nation/id=" + id; }
function warUrl(id: number) { return "https://politicsandwar.com/nation/war/declare/id=" + id; }
