import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import type { NationDetail } from "../pnw/nations.js";

export type DossierData = {
  target: NationDetail;
  attacker?: NationDetail;
  nearPct: number;
  // attacker's declare window = attackerScore * [0.75..2.5]
  window: { min: number; max: number };
  status: { inRange: boolean; nearRange: boolean; deltaPct?: number; side?: "below" | "above" };
};

export function dossierEmbed(d: DossierData) {
  const t = d.target;
  const a = d.attacker;

  // Color by status
  const color = d.status.inRange ? 0x22c55e : d.status.nearRange ? 0xeab308 : 0xef4444; // green/yellow/red

  const e = new EmbedBuilder()
    .setColor(color)
    .setTitle(`🎯 ${t.name}  #${t.id}`)
    .setURL(nationUrl(t.id))
    .setDescription(rangeStatusLine(d) + "\n" + (a?.score && t.score ? ("\n" + rangeGauge(a.score, t.score, d.window)) : ""))
    .addFields(
      {
        name: "🧭 Access",
        value: accessBlock(d),
        inline: false
      },
      {
        name: "🪪 Profile",
        value: profileBlock(t),
        inline: true
      },
      {
        name: "🛡️ Military",
        value: militaryBlock(t),
        inline: true
      }
    )
    .setFooter({ text: `Near-range: ${d.nearPct}% • Open nation → buttons below` });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setLabel("Open Nation").setStyle(ButtonStyle.Link).setURL(nationUrl(t.id)),
    new ButtonBuilder().setLabel("Declare War").setStyle(ButtonStyle.Link).setURL(warUrl(t.id))
  );

  return { embeds: [e], components: [row] };
}

// ---- Sections ---------------------------------------------------------------

function accessBlock(d: DossierData) {
  const t = d.target;
  const a = d.attacker;

  const lines: string[] = [];
  lines.push(`📈 Target score: **${fmtScore(t.score)}**`);
  if (a) {
    lines.push(`🗡️ Your score: **${fmtScore(a.score)}**`);
    if (a.score != null) {
      lines.push(`📏 Window: **${fmtScore(d.window.min)}–${fmtScore(d.window.max)}**`);
    }
  }
  lines.push(slotsLine(t));
  lines.push(timersLine(t));
  return lines.filter(Boolean).join("\n");
}

function profileBlock(t: NationDetail) {
  const parts: string[] = [];
  parts.push(aaLine(t));
  parts.push(`🏙️ Cities: **${fmtInt(t.cities)}**`);
  const last = lastActiveLine(t);
  if (last) parts.push(`⏱️ ${last}`);
  return parts.filter(Boolean).join("\n");
}

function militaryBlock(t: NationDetail) {
  const cells = [
    troop("🪖", "Soldiers", t.soldiers),
    troop("🧨", "Tanks", t.tanks),
    troop("✈️", "Aircraft", t.aircraft),
    troop("🚢", "Ships", t.ships),
    troop("🚀", "Missiles", t.missiles),
    troop("☢️", "Nukes", t.nukes)
  ].filter(Boolean);

  // Split into two tidy lines if long
  const half = Math.ceil(cells.length / 2);
  const line1 = cells.slice(0, half).join("   ");
  const line2 = cells.slice(half).join("   ");
  return [line1, line2].filter(Boolean).join("\n");
}

// ---- Status & Gauge ---------------------------------------------------------

function rangeStatusLine(d: DossierData) {
  if (!d.attacker?.score || !d.target.score) return "⚠️ Missing scores to compute range.";
  if (d.status.inRange) return "🟢 **In Range** — you can declare now.";
  if (d.status.nearRange) {
    const side = d.status.side === "below" ? "below" : "above";
    const delta = typeof d.status.deltaPct === "number" ? `${Math.abs(d.status.deltaPct).toFixed(1)}%` : "?";
    return `🟡 **Near-Range** — ${delta} ${side} window (within ${d.nearPct}%).`;
  }
  return "🔴 **Out of Range**.";
}

// Text gauge showing where the target sits vs your window
// e.g.  [7.7k] |=====▸====| [25.5k]   (▸ marks target; bar is your window)
function rangeGauge(attackerScore: number, targetScore: number, win: { min: number; max: number }) {
  if (!isNum(attackerScore) || !isNum(targetScore) || win.max <= win.min) return "";

  const width = 18; // characters inside the window bar
  const pos = (targetScore - win.min) / (win.max - win.min);
  const clamped = Math.max(0, Math.min(1, pos));
  const idx = Math.min(width - 1, Math.max(0, Math.floor(clamped * width)));

  const cells = Array.from({ length: width }, () => "═");
  cells[idx] = "▸";

  const left = `［${fmtShort(win.min)}］`;
  const right = `［${fmtShort(win.max)}］`;

  // Add arrows if outside
  const outsideLeft = pos < 0 ? "⇦ " : "";
  const outsideRight = pos > 1 ? " ⇨" : "";

  return `${outsideLeft}${left} │${cells.join("")}│ ${right}${outsideRight}`;
}

// ---- Lines & helpers --------------------------------------------------------

function slotsLine(t: NationDetail) {
  const offActive = clamp(0, 3, t.offensiveWars ?? 0);
  const defActive = clamp(0, 3, t.defensiveWars ?? 0);
  const offOpen = 3 - offActive;
  const defOpen = 3 - defActive;
  return `🎟️ Slots — Off: **${offOpen}/3** (active ${offActive}) • Def: **${defOpen}/3** (active ${defActive})`;
}

function timersLine(t: NationDetail) {
  const beige = t.beigeTurns ?? 0;
  const vm = t.vmTurns ?? 0;
  const parts = [];
  parts.push(beige > 0 ? `🧱 Beige: **${beige}t**` : "🧱 Beige: **none**");
  if (vm > 0) parts.push(`🏖️ VM: **${vm}t**`);
  return parts.join(" • ");
}

function aaLine(t: NationDetail) {
  if (!t.allianceId && !t.allianceName) return "🏷️ AA: **None/Gray**";
  if (t.allianceId && t.allianceName) return `🏷️ AA: **${t.allianceName}** (#${t.allianceId})`;
  if (t.allianceName) return `🏷️ AA: **${t.allianceName}**`;
  return `🏷️ AA: **#${t.allianceId}**`;
}

function lastActiveLine(t: NationDetail) {
  const m = t.lastActiveMinutes;
  if (m == null) return null;
  if (m < 60) return `Last active **${m}m** ago`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `Last active **${h}h ${rm}m** ago`;
}

function troop(emoji: string, label: string, n: number | null) {
  if (n == null) return null;
  return `${emoji} ${label}: **${fmtInt(n)}**`;
}

// ---- format utils -----------------------------------------------------------

function isNum(n: unknown): n is number { return typeof n === "number" && Number.isFinite(n); }
function clamp(lo: number, hi: number, v: number) { return Math.max(lo, Math.min(hi, v)); }
function fmtScore(n: number | null) { return n == null ? "—" : Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(n); }
function fmtInt(n: number | null) { return n == null ? "—" : Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n); }
function fmtShort(n: number) {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1000000) return (n / 1000).toFixed(0) + "k"; // scores are big; compress
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(Math.round(n));
}

function nationUrl(id: number) { return "https://politicsandwar.com/nation/id=" + id; }
function warUrl(id: number) { return "https://politicsandwar.com/nation/war/declare/id=" + id; }
