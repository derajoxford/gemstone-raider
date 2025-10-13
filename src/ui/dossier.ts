import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import type { NationDetail } from "../pnw/nations.js";

export type DossierData = {
  target: NationDetail;
  attacker?: NationDetail;
  nearPct: number;
  window: { min: number; max: number }; // attackerScore * [0.75..2.5]
  status: { inRange: boolean; nearRange: boolean; deltaPct?: number; side?: "below" | "above" };
};

export function dossierEmbed(d: DossierData) {
  const t = d.target;
  const a = d.attacker;

  const e = new EmbedBuilder()
    .setTitle(`🎯 ${t.name} (#${t.id})`)
    .setURL(nationUrl(t.id))
    .setDescription(statusLine(d))
    .addFields(
      {
        name: "Access",
        value: [
          `Score: **${fmtScore(t.score)}**`,
          a ? `Your score: **${fmtScore(a.score)}**` : null,
          a ? `Declare window: **${fmtScore(d.window.min)}–${fmtScore(d.window.max)}**` : null,
          slotsLine(t),
          timersLine(t)
        ].filter(Boolean).join("\n"),
        inline: false
      },
      {
        name: "Profile",
        value: [
          aaLine(t),
          `Cities: **${fmtInt(t.cities)}**`,
          lastActiveLine(t)
        ].filter(Boolean).join("\n"),
        inline: true
      },
      {
        name: "Military",
        value: [
          troop("Soldiers", t.soldiers),
          troop("Tanks", t.tanks),
          troop("Aircraft", t.aircraft),
          troop("Ships", t.ships),
          troop("Missiles", t.missiles),
          troop("Nukes", t.nukes)
        ].filter(Boolean).join(" • "),
        inline: true
      }
    )
    .setFooter({ text: `Near-range: ${d.nearPct}%` });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setLabel("Open Nation").setStyle(ButtonStyle.Link).setURL(nationUrl(t.id)),
    new ButtonBuilder().setLabel("Declare War").setStyle(ButtonStyle.Link).setURL(warUrl(t.id))
  );

  return { embeds: [e], components: [row] };
}

function statusLine(d: DossierData) {
  if (!d.attacker?.score || !d.target.score) return "⚠️ Missing scores to compute range.";
  if (d.status.inRange) return "✅ **In Range** — you can declare now.";
  if (d.status.nearRange) {
    const side = d.status.side === "below" ? "below" : "above";
    const delta = typeof d.status.deltaPct === "number" ? `${Math.abs(d.status.deltaPct).toFixed(1)}%` : "?";
    return `🟡 **Near-Range** — ${delta} ${side} window (within ${d.nearPct}%).`;
  }
  return "❌ **Out of Range**.";
}

function slotsLine(t: NationDetail) {
  const off = clamp(0, 3, (t.offensiveWars ?? 0));
  const def = clamp(0, 3, (t.defensiveWars ?? 0));
  const offOpen = Math.max(0, 3 - off);
  const defOpen = Math.max(0, 3 - def);
  return `War slots — Off: **${offOpen}/3** (active ${off}) • Def: **${defOpen}/3** (active ${def})`;
}

function timersLine(t: NationDetail) {
  const beige = t.beigeTurns ?? 0;
  const vm = t.vmTurns ?? 0;
  const parts = [];
  parts.push(beige > 0 ? `Beige: **${beige}t**` : "Beige: **none**");
  if (vm > 0) parts.push(`VM: **${vm}t**`);
  return parts.join(" • ");
}

function aaLine(t: NationDetail) {
  if (!t.allianceId && !t.allianceName) return "AA: **None/Gray**";
  if (t.allianceId && t.allianceName) return `AA: **${t.allianceName}** (#${t.allianceId})`;
  if (t.allianceName) return `AA: **${t.allianceName}**`;
  return `AA: **#${t.allianceId}**`;
}

function lastActiveLine(t: NationDetail) {
  const m = t.lastActiveMinutes;
  if (m == null) return null;
  if (m < 60) return `Last active: **${m}m**`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `Last active: **${h}h ${rm}m**`;
}

function troop(label: string, n: number | null) {
  if (n == null) return null;
  return `${label}: **${fmtInt(n)}**`;
}

function fmtScore(n: number | null) {
  return n == null ? "—" : Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(n);
}
function fmtInt(n: number | null) {
  return n == null ? "—" : Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n);
}
function clamp(lo: number, hi: number, v: number) { return Math.max(lo, Math.min(hi, v)); }
function nationUrl(id: number) { return "https://politicsandwar.com/nation/id=" + id; }
function warUrl(id: number) { return "https://politicsandwar.com/nation/war/declare/id=" + id; }
