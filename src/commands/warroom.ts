// src/commands/warroom.ts
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelType,
  ChatInputCommandInteraction,
  EmbedBuilder,
  GuildMember,
  ModalBuilder,
  ModalSubmitInteraction,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextChannel,
  TextInputBuilder,
  TextInputStyle,
  userMention,
} from "discord.js";
import { query } from "../data/db.js";

type Cmd = {
  data: SlashCommandBuilder;
  execute(i: ChatInputCommandInteraction): Promise<void>;
  handleButton?(i: ButtonInteraction): Promise<boolean>;
  handleModal?(i: ModalSubmitInteraction): Promise<boolean>;
};

const CATEGORY_NAME = process.env.WARROOM_CATEGORY_NAME || "WAR ROOMS";
const PNW_API_KEY = process.env.PNW_API_KEY || process.env.PNW_DEFAULT_API_KEY || "";

// cache during setup (keyed by guild:user)
const pendingSetup = new Map<
  string,
  { targetId: number; targetUrl: string; preMembers: string[] }
>();
const setupKey = (guildId: string, userId: string) => `${guildId}:${userId}`;

/* ---------- Helpers ---------- */

function normalizeTarget(raw: string): { id: number; url: string } | null {
  const s = (raw || "").trim();

  // Prefer explicit id=... first (works for e.g. https://politicsandwar.com/nation/id=246232&foo=bar)
  let m = s.match(/[?&]id=(\d{1,9})/i) || s.match(/\/id=(\d{1,9})/i);
  if (!m) {
    // Fallback: take the LAST 3–9 digit run in the string
    const all = [...s.matchAll(/(\d{3,9})/g)];
    if (all.length) m = all[all.length - 1];
  }
  if (!m) return null;

  const id = Number(m[1]);
  if (!Number.isFinite(id) || id <= 0) return null;

  // Canonical nation URL
  const url = `https://politicsandwar.com/nation/id=${id}`;
  return { id, url };
}

async function fetchNationName(id: number): Promise<string | null> {
  const q = `{ nations(id:${id}){ data{ nation_name } } }`;
  const url = `https://api.politicsandwar.com/graphql?api_key=${encodeURIComponent(PNW_API_KEY)}`;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: q }),
    });
    if (!r.ok) return null;
    const j: any = await r.json();
    const name = j?.data?.nations?.data?.[0]?.nation_name;
    return typeof name === "string" && name.trim() ? name.trim() : null;
  } catch {
    return null;
  }
}

type Dossier = {
  alliance?: string;
  score?: number;
  cities?: number;
  soldiers?: number;
  tanks?: number;
  aircraft?: number;
  ships?: number;
  missiles?: number;
  nukes?: number;
  beige?: number;
};

async function fetchNationDossier(id: number): Promise<Dossier | null> {
  const q = `
  query {
    nations(id:${id}) {
      data {
        nation_name
        alliance_name
        alliance_id
        score
        cities
        soldiers
        tanks
        aircraft
        ships
        missiles
        nukes
        beige_turns
      }
    }
  }`;
  const url = `https://api.politicsandwar.com/graphql?api_key=${encodeURIComponent(PNW_API_KEY)}`;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: q }),
    });
    if (!r.ok) return null;
    const j: any = await r.json();
    const d = j?.data?.nations?.data?.[0];
    if (!d) return null;
    const dossier: Dossier = {
      alliance: d.alliance_name || undefined,
      score: safeNum(d.score),
      cities: safeNum(d.cities),
      soldiers: safeNum(d.soldiers),
      tanks: safeNum(d.tanks),
      aircraft: safeNum(d.aircraft),
      ships: safeNum(d.ships),
      missiles: safeNum(d.missiles),
      nukes: safeNum(d.nukes),
      beige: safeNum(d.beige_turns),
    };
    return dossier;
  } catch {
    return null;
  }
}

function safeNum(n: any): number | undefined {
  const v = Number(n);
  return Number.isFinite(v) ? v : undefined;
}

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

function parseUserTokens(input: string): string[] {
  const parts = (input || "")
    .split(/[\s,]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const ids = new Set<string>();
  for (const p of parts) {
    const m = p.match(/<@!?(\d+)>/);
    const id = m ? m[1] : p.replace(/[^\d]/g, "");
    if (id) ids.add(id);
  }
  return Array.from(ids);
}

function controlButtons(roomId: number) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`war:add:${roomId}`).setLabel("➕ Add Member").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`war:remove:${roomId}`).setLabel("➖ Remove Member").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`war:refresh:${roomId}`).setLabel("♻️ Refresh Dossier").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`war:close:${roomId}`).setLabel("⛔ Close War Room").setStyle(ButtonStyle.Danger),
  );
}

function renderDossier(d: Dossier | null): string {
  if (!d) return "_No dossier yet. Press **Refresh Dossier**._";
  const lines: string[] = [];
  if (d.alliance) lines.push(`🛡️ **Alliance:** ${d.alliance}`);
  const top: string[] = [];
  if (d.score != null) top.push(`📈 **Score:** ${formatNum(d.score)}`);
  if (d.cities != null) top.push(`🏙️ **Cities:** ${formatNum(d.cities)}`);
  if (top.length) lines.push(top.join(" • "));
  const mil: string[] = [];
  if (d.soldiers != null) mil.push(`🪖 ${formatNum(d.soldiers)}`);
  if (d.tanks != null) mil.push(`🛞 ${formatNum(d.tanks)}`);
  if (d.aircraft != null) mil.push(`✈️ ${formatNum(d.aircraft)}`);
  if (d.ships != null) mil.push(`🚢 ${formatNum(d.ships)}`);
  if (d.missiles != null) mil.push(`🎯 ${formatNum(d.missiles)}`);
  if (d.nukes != null
