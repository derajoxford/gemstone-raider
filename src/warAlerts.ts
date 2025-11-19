// src/warAlerts.ts
import * as https from "https";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  Channel,
  Client,
  Colors,
  EmbedBuilder,
  TextChannel,
} from "discord.js";
import { query } from "./data/db.js";
import { fetchActiveWars, type WarRecord } from "./pnw/wars.js";

// ---- GraphQL queries ----

const WAR_QUERY = `
{
  wars(first: 50) {
    data {
      id
      date
      war_type
      att_id
      def_id
      att_alliance_id
      def_alliance_id
      ground_control
      naval_blockade
      turns_left
      winner_id
      attacker {
        id
        nation_name
        alliance_id
        alliance { id name }
      }
      defender {
        id
        nation_name
        alliance_id
        alliance { id name }
      }
    }
  }
}
`;

function nationMilQuery(nationId: string | number): string {
  // GraphQL nations query with spies included
  return `
  {
    nations(id: ${nationId}, first: 1) {
      data {
        id
        nation_name
        alliance_id
        soldiers
        tanks
        aircraft
        ships
        missiles
        nukes
        spies
      }
    }
  }`;
}

// ---- Types ----

interface WarSideAlliance {
  id: string;
  name: string;
}

interface WarSide {
  id: string;
  nation_name: string;
  alliance_id: string;
  alliance: WarSideAlliance | null;
}

interface War {
  id: string;
  date: string;
  war_type: string;
  att_id: string;
  def_id: string;
  att_alliance_id: string;
  def_alliance_id: string;
  ground_control: string;
  naval_blockade: string;
  turns_left: number;
  winner_id: string;
  attacker: WarSide;
  defender: WarSide;
}

interface WarApiResponse {
  data?: {
    wars?: {
      data?: War[];
    };
  };
  errors?: { message: string }[];
}

interface NationGraphResponse {
  data?: {
    nations?: {
      data?: Array<{
        id: string;
        nation_name: string;
        alliance_id: string;
        soldiers: any;
        tanks: any;
        aircraft: any;
        ships: any;
        missiles: any;
        nukes: any;
        spies: any;
      }>;
    };
  };
  errors?: { message: string }[];
}

interface WarMessageRef {
  warId: string;
  channelId: string;
  messageId: string;
  isDefensive: boolean;
}

interface NationMilitary {
  soldiers: number | null;
  tanks: number | null;
  aircraft: number | null;
  ships: number | null;
  missiles: number | null;
  nukes: number | null;
  spies: number | null;
}

type DossierInfo = {
  score?: number;
  cities?: number;
  soldiers?: number;
  tanks?: number;
  aircraft?: number;
  ships?: number;
  missiles?: number;
  nukes?: number;
  beigeTurns?: number;
  allianceName?: string;
};

type WarRoomAutoRow = {
  created_by_id: string;
  target_nation_id: number;
  target_nation_name: string;
  notes: string | null;
  member_ids: string[];
  created_at: Date;
};

// ---- State ----

const warMessageMap = new Map<string, WarMessageRef>();

const MILITARY_CACHE_TTL_MS = 2 * 60 * 1000;
const militaryCache = new Map<
  string,
  { data: NationMilitary; fetchedAt: number }
>();

// ---- HTTP helpers ----

function httpPost(
  hostname: string,
  path: string,
  payload: string,
): Promise<{ statusCode?: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          resolve({ statusCode: res.statusCode, body });
        });
      },
    );

    req.on("error", (err) => reject(err));
    req.write(payload);
    req.end();
  });
}

// ---- utils ----

function parseNum(v: any): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function formatNum(n: number | null): string {
  if (n === null || Number.isNaN(n)) return "?";
  return n.toLocaleString("en-US");
}

function ago(iso?: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const ms = Date.now() - t;
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  if (d > 0) return `${d}d ${h}h ago`;
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h > 0) return `${h}h ${m}m ago`;
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${s}s ago`;
}

// ---- REST dossier ----

async function fetchNationDossier(
  nationId: number,
): Promise<DossierInfo | null> {
  const base =
    (process.env.PNW_API_BASE_REST || "https://politicsandwar.com/api").trim();
  const key =
    (process.env.PNW_API_KEY ||
      process.env.PNW_DEFAULT_API_KEY ||
      process.env.PNW_SERVICE_API_KEY ||
      "").trim();
  if (!key) return null;
  const url = `${base.replace(
    /\/+$/,
    "",
  )}/nation/id=${nationId}/&key=${encodeURIComponent(key)}`;
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const d: any = await res.json();
    if (d?.success === false) return null;
    const num = (v: any) =>
      v !== undefined && Number.isFinite(Number(v)) ? Number(v) : undefined;
    return {
      score: num(d.score),
      cities: num(d.cities),
      soldiers: num(d.soldiers),
      tanks: num(d.tanks),
      aircraft: num(d.aircraft),
      ships: num(d.ships),
      missiles: num(d.missiles),
      nukes: num(d.nukes),
      beigeTurns: num(d.beige_turns_left ?? d.beige_turns),
      allianceName:
        typeof d.alliance === "string" && d.alliance !== "0"
          ? d.alliance
          : undefined,
    };
  } catch {
    return null;
  }
}

// ---- GraphQL calls ----

async function fetchWars(apiKey: string): Promise<War[]> {
  const payload = JSON.stringify({ query: WAR_QUERY });

  try {
    const { statusCode, body } = await httpPost(
      "api.politicsandwar.com",
      `/graphql?api_key=${apiKey}`,
      payload,
    );

    if (statusCode && statusCode >= 400) {
      console.error("[war-alerts] HTTP error", statusCode, body.slice(0, 300));
      return [];
    }

    const json = JSON.parse(body) as WarApiResponse;
    if (json.errors && json.errors.length > 0) {
      console.error(
        "[war-alerts] GraphQL errors",
        json.errors.map((e) => e.message).join("; "),
      );
      return [];
    }
    return json.data?.wars?.data ?? [];
  } catch (err) {
    console.error("[war-alerts] failed to fetch wars", err);
    return [];
  }
}

async function fetchNationMilitary(
  apiKey: string,
  nationId: string,
): Promise<NationMilitary | null> {
  if (!apiKey) return null;

  const cached = militaryCache.get(nationId);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < MILITARY_CACHE_TTL_MS) {
    return cached.data;
  }

  const payload = JSON.stringify({ query: nationMilQuery(nationId) });

  try {
    const { statusCode, body } = await httpPost(
      "api.politicsandwar.com",
      `/graphql?api_key=${apiKey}`,
      payload,
    );

    if (statusCode && statusCode >= 400) {
      console.error(
        "[war-alerts] nation GQL HTTP error",
        statusCode,
        body.slice(0, 300),
      );
      return null;
    }

    const json = JSON.parse(body) as NationGraphResponse;
    if (json.errors && json.errors.length > 0) {
      console.error(
        "[war-alerts] nation GQL errors",
        json.errors.map((e) => e.message).join("; "),
      );
      return null;
    }

    const node = json.data?.nations?.data?.[0];
    if (!node) {
      console.warn("[war-alerts] nation not found in GQL", nationId);
      return null;
    }

    const mil: NationMilitary = {
      soldiers: parseNum(node.soldiers),
      tanks: parseNum(node.tanks),
      aircraft: parseNum(node.aircraft),
      ships: parseNum(node.ships),
      missiles: parseNum(node.missiles),
      nukes: parseNum(node.nukes),
      spies: parseNum(node.spies),
    };

    militaryCache.set(nationId, { data: mil, fetchedAt: now });
    return mil;
  } catch (err) {
    console.error("[war-alerts] nation GQL fetch failed", nationId, err);
    return null;
  }
}

// ---- embed helpers ----

function warStatus(war: War): string {
  if (war.winner_id && war.winner_id !== "0") return "Finished";
  if (war.turns_left <= 0) return "Expired";
  return "Active";
}

function warUrl(warId: string): string {
  return `https://politicsandwar.com/nation/war/timeline/war=${warId}`;
}

function nationUrl(id: string): string {
  return `https://politicsandwar.com/nation/id=${id}`;
}

function allianceUrl(id: string): string {
  return `https://politicsandwar.com/alliance/id=${id}`;
}

function nationLink(id: number, name?: string | null) {
  const safe = name && name.trim().length ? name.trim() : `Nation #${id}`;
  return `[${safe}](${nationUrl(String(id))})`;
}

function formatSideBlock(
  war: War,
  side: "ATTACKER" | "DEFENDER",
  mil: NationMilitary | null,
): string {
  const isAtt = side === "ATTACKER";
  const node = isAtt ? war.attacker : war.defender;
  const nationId = isAtt ? war.att_id : war.def_id;

  const hasGC = war.ground_control === nationId;
  const hasNB = war.naval_blockade === nationId;

  const lines: string[] = [];

  const nationName = node?.nation_name ?? "Unknown";
  lines.push(`**[${nationName}](${nationUrl(nationId)})**`);

  const allianceId = node?.alliance_id ?? "0";
  const allianceName =
    node?.alliance?.name ??
    (allianceId === "0" ? "None" : `Unknown (#${allianceId})`);

  if (allianceId !== "0" && node?.alliance?.name) {
    lines.push(`Alliance: [${allianceName}](${allianceUrl(allianceId)})`);
  } else {
    lines.push(`Alliance: ${allianceName}`);
  }

  lines.push(`Nation ID: \`${nationId}\``);
  lines.push("");
  lines.push(`🟩 Ground Control: ${hasGC ? "✅" : "❌"}`);
  lines.push(`🚫 Naval Blockade: ${hasNB ? "✅" : "❌"}`);

  if (mil) {
    lines.push("");
    lines.push(`💂 **Soldiers:** ${formatNum(mil.soldiers)}`);
    lines.push(`🛡️ **Tanks:** ${formatNum(mil.tanks)}`);
    lines.push(`✈️ **Aircraft:** ${formatNum(mil.aircraft)}`);
    lines.push(`🚢 **Ships:** ${formatNum(mil.ships)}`);
    lines.push(`🎯 **Missiles:** ${formatNum(mil.missiles)}`);
    lines.push(`☢️ **Nukes:** ${formatNum(mil.nukes)}`);
    lines.push(`🕵️ **Spies:** ${formatNum(mil.spies)}`);
  }

  return lines.join("\n");
}

function buildComponents(warId: string) {
  const openButton = new ButtonBuilder()
    .setStyle(ButtonStyle.Link)
    .setLabel("Open War")
    .setEmoji("🌐")
    .setURL(warUrl(warId));

  const refreshButton = new ButtonBuilder()
    .setStyle(ButtonStyle.Primary)
    .setLabel("Refresh")
    .setEmoji("🔄")
    .setCustomId(`war:refresh:${warId}`);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    openButton,
    refreshButton,
  );

  return [row];
}

function formatWarsBlock(
  offense: WarRecord[],
  defense: WarRecord[],
): string {
  const slotLine = `🎯 **Slots:** O ${offense.length}/3 • D ${defense.length}/3`;

  const fmtOff = (w: WarRecord) => {
    const enemy = w.defender?.nation_name || `#${w.defender_id}`;
    const started = ago(w.date);
    const turns = w.turns_left ?? "?";
    return [
      `• 💥 vs **${enemy}**`,
      `   ⏱️ ${started} — ⏳ T${turns}`,
      `   🔗 [Open War](https://politicsandwar.com/nation/war/status/war=${w.id}) • [Open Nation](https://politicsandwar.com/nation/id=${w.defender_id}) • [Declare](https://politicsandwar.com/nation/war/declare/id=${w.defender_id})`,
    ].join("\n");
  };
  const fmtDef = (w: WarRecord) => {
    const enemy = w.attacker?.nation_name || `#${w.attacker_id}`;
    const started = ago(w.date);
    const turns = w.turns_left ?? "?";
    return [
      `• 🛡️ vs **${enemy}**`,
      `   ⏱️ ${started} — ⏳ T${turns}`,
      `   🔗 [Open War](https://politicsandwar.com/nation/war/status/war=${w.id}) • [Open Nation](https://politicsandwar.com/nation/id=${w.attacker_id}) • [Declare](https://politicsandwar.com/nation/war/declare/id=${w.attacker_id})`,
    ].join("\n");
  };

  const oBlock = offense.length ? offense.map(fmtOff).join("\n\n") : "*None*";
  const dBlock = defense.length ? defense.map(fmtDef).join("\n\n") : "*None*";

  return [
    slotLine,
    "",
    `🗡️ **Offense**`,
    oBlock,
    "",
    `🛡️ **Defense**`,
    dBlock,
  ].join("\n");
}

function formatDossierBlock(d: DossierInfo | null): string {
  if (!d) return "No dossier data.";
  const out: string[] = [];
  if (d.allianceName) out.push(`🧑‍🤝‍🧑 **Alliance:** ${d.allianceName}`);
  if (d.score !== undefined) out.push(`📈 **Score:** ${d.score.toFixed(2)}`);
  if (d.cities !== undefined) out.push(`🏙️ **Cities:** ${d.cities}`);

  const mil: string[] = [];
  if (d.soldiers !== undefined) mil.push(`🪖 ${d.soldiers.toLocaleString()}`);
  if (d.tanks !== undefined) mil.push(`🛡️ ${d.tanks.toLocaleString()}`);
  if (d.aircraft !== undefined) mil.push(`✈️ ${d.aircraft.toLocaleString()}`);
  if (d.ships !== undefined) mil.push(`🚢 ${d.ships.toLocaleString()}`);
  if (mil.length) out.push(`⚔️ **Military:** ${mil.join(" • ")}`);

  const boom: string[] = [];
  if (d.missiles !== undefined) boom.push(`🎯 ${d.missiles}`);
  if (d.nukes !== undefined) boom.push(`☢️ ${d.nukes}`);
  if (boom.length) out.push(`💣 **Strategic:** ${boom.join(" • ")}`);

  if (d.beigeTurns !== undefined)
    out.push(`🟫 **Beige:** ${d.beigeTurns} turns`);

  return out.length ? out.join("\n") : "No dossier data.";
}

function buildWarEmbed(
  war: War,
  ourAllianceId: string,
  attMil: NationMilitary | null,
  defMil: NationMilitary | null,
): EmbedBuilder {
  const isOffense = war.att_alliance_id === ourAllianceId;
  const isDefense = war.def_alliance_id === ourAllianceId;

  const side =
    isOffense ? "OFFENSE" : isDefense ? "DEFENSE" : ("NONE" as const);

  const titleEmoji = side === "OFFENSE" ? "⚔️" : "🛡️";
  const color = side === "OFFENSE" ? 0xf39c12 : 0x3498db;

  const description = [
    `Type: **${war.war_type}**`,
    `Started: **${war.date}**`,
    `Status: **${warStatus(war)}**`,
    `Turns Left: **${war.turns_left}**`,
  ].join(" • ");

  const ourSideText =
    side === "OFFENSE"
      ? "🗡️ Attacker"
      : side === "DEFENSE"
      ? "🛡️ Defender"
      : "❓ Not involved";

  const embed = new EmbedBuilder()
    .setTitle(
      `${titleEmoji} ${
        side === "OFFENSE" ? "Offensive" : "Defensive"
      } War #${war.id}`,
    )
    .setDescription(description)
    .addFields(
      {
        name: "Attacker",
        value: formatSideBlock(war, "ATTACKER", attMil),
        inline: false, // stacked
      },
      {
        name: "Defender",
        value: formatSideBlock(war, "DEFENDER", defMil),
        inline: false, // stacked
      },
      {
        name: "Our Side",
        value: ourSideText,
        inline: false,
      },
    )
    .setColor(color)
    .setFooter({
      text: "War alerts • auto-updating • use 🔄 Refresh for the latest snapshot",
    })
    .setTimestamp(new Date());

  return embed;
}

function isTextChannel(ch: Channel | null): ch is TextChannel {
  return !!ch && (ch as TextChannel).send !== undefined;
}

// ---- War Room helpers (auto-open for defensive wars) ----

function buildWarRoomControlRow() {
  // Must match src/commands/warroom.ts button customIds
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("warroom:addMember")
      .setLabel("Add Member")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("warroom:removeMember")
      .setLabel("Remove Member")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("warroom:refreshDossier")
      .setLabel("Refresh Dossier + Wars")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("warroom:close")
      .setLabel("Close War Room")
      .setStyle(ButtonStyle.Danger),
  );
}

function buildAutoWarRoomEmbed(
  row: WarRoomAutoRow,
  dossier: DossierInfo | null,
  offense: WarRecord[],
  defense: WarRecord[],
): EmbedBuilder {
  const members =
    row.member_ids.length > 0
      ? row.member_ids.map((id) => `<@${id}>`).join("\n")
      : "*none*";

  return new EmbedBuilder()
    .setColor(Colors.DarkRed)
    .setTitle(`💥 WAR ROOM — ${row.target_nation_name}`)
    .setDescription(
      [
        `🎯 **Target:** ${nationLink(
          row.target_nation_id,
          row.target_nation_name,
        )}`,
        `👤 **Created by:** <@${row.created_by_id}>`,
        "",
        "⚔️ **Active Wars** (Offense + Defense)",
        formatWarsBlock(offense, defense),
        "",
        "📝 **Notes**",
        row.notes?.trim() || "*none*",
        "",
        "👥 **Members**",
        members,
        "",
        "📊 **Dossier**",
        formatDossierBlock(dossier),
      ].join("\n"),
    )
    .setFooter({ text: "Gemstone Raider — War Room" })
    .setTimestamp(row.created_at ?? new Date());
}

async function ensureAutoWarRoomForDefense(
  client: Client,
  guildId: string,
  war: War,
): Promise<void> {
  // War rooms are keyed by the nation being attacked.
  // For a defensive war, the *defender* (our member) is being attacked.
  const targetNationId = Number(war.def_id);
  if (!Number.isFinite(targetNationId) || targetNationId <= 0) return;

  // Check if a war room already exists for this target in this guild.
  try {
    const { rows } = await query<{
      id: string;
      channel_id: string;
      target_nation_id: number;
    }>(
      `SELECT id, channel_id, target_nation_id
       FROM war_rooms
       WHERE guild_id=$1 AND target_nation_id=$2
       LIMIT 1`,
      [guildId, targetNationId],
    );

    if (rows.length > 0) {
      // Already have a war room for this target; nothing to do.
      return;
    }
  } catch (err) {
    console.error(
      "[war-alerts] failed checking existing war room for target",
      targetNationId,
      err,
    );
    // Don't try to auto-create if we can't verify; be safe.
    return;
  }

  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) {
    console.warn("[war-alerts] guild not found for auto war room", guildId);
    return;
  }

  const targetName =
    war.defender?.nation_name || `Nation #${targetNationId}`;

  const slug = targetName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const channelName = `war-${slug || targetNationId}`;

  const categoryName = process.env.WARROOM_CATEGORY_NAME || "WAR ROOMS";

  // Find or create the WAR ROOMS category (type 4 = Category)
  let warCat =
    guild.channels.cache.find(
      (c: any) =>
        c.type === 4 &&
        typeof c.name === "string" &&
        c.name.toLowerCase() === categoryName.toLowerCase(),
    ) || null;

  if (!warCat) {
    warCat = await guild.channels.create({
      name: categoryName,
      type: 4,
      reason: "Gemstone Raider — War Rooms category (auto)",
    } as any);
  }

  // Create the war room text channel under the category
  const channel = await guild.channels.create({
    name: channelName,
    parent: (warCat as any).id,
    topic: `War room for ${targetName} (#${targetNationId}) — auto-created for defensive war #${war.id}`,
    reason: `War room auto-created by war alerts for defensive war #${war.id}`,
  } as any);

  const createdById =
    guild.members.me?.id || client.user?.id || "0";

  const notes = `Auto-created for defensive war #${war.id}; this nation is being attacked.`;
  const memberIds: string[] = []; // start with no explicit members; buttons can add later
  const createdAt = new Date();

  // Fetch dossier + wars for initial embed
  let dossier: DossierInfo | null = null;
  let offense: WarRecord[] = [];
  let defense: WarRecord[] = [];

  try {
    dossier = await fetchNationDossier(targetNationId);
  } catch (err) {
    console.error(
      "[war-alerts] auto war room dossier fetch failed",
      targetNationId,
      err,
    );
  }

  try {
    const res = await fetchActiveWars(targetNationId);
    offense = res.offense;
    defense = res.defense;
  } catch (err) {
    console.error(
      "[war-alerts] auto war room active wars fetch failed",
      targetNationId,
      err,
    );
  }

  let controlMsgId: string | null = null;

  // Seed the channel with full control embed + buttons.
  try {
    const textChannel = channel as TextChannel;
    const row: WarRoomAutoRow = {
      created_by_id: createdById,
      target_nation_id: targetNationId,
      target_nation_name: targetName,
      notes,
      member_ids: memberIds,
      created_at: createdAt,
    };
    const embed = buildAutoWarRoomEmbed(row, dossier, offense, defense);
    const msg = await textChannel.send({
      embeds: [embed],
      components: [buildWarRoomControlRow()],
    });
    controlMsgId = msg.id;
    await msg.pin().catch(() => {});
  } catch (err) {
    console.error(
      "[war-alerts] failed sending initial auto war room embed",
      err,
    );
  }

  // Insert DB row (even if embed failed, we still want the record)
  try {
    await query(
      `
      INSERT INTO war_rooms
        (guild_id, channel_id, control_message_id, name, created_by_id,
         target_nation_id, target_nation_name, notes, member_ids)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    `,
      [
        guild.id,
        channel.id,
        controlMsgId,
        targetName,
        createdById,
        targetNationId,
        targetName,
        notes,
        memberIds,
      ],
    );
  } catch (err) {
    console.error(
      "[war-alerts] failed inserting auto war room row",
      targetNationId,
      err,
    );
  }

  console.log(
    "[war-alerts] auto war room created for target",
    targetNationId,
    "war",
    war.id,
  );
}

// ---- env + runner ----

function getEnv() {
  const apiKey = (
    process.env.PNW_GRAPH_KEY ||
    process.env.PNW_API_KEY ||
    process.env.PNW_SERVICE_API_KEY ||
    process.env.PNW_DEFAULT_API_KEY ||
    ""
  ).trim();
  const allianceId = (process.env.WAR_ALERTS_AID || "").trim();
  const guildId = (process.env.WAR_ALERTS_GUILD_ID || "").trim();
  const offenseChannelId = (
    process.env.WAR_ALERTS_OFFENSE_CHANNEL_ID || ""
  ).trim();
  const defenseChannelId = (
    process.env.WAR_ALERTS_DEFENSE_CHANNEL_ID || ""
  ).trim();
  const defensePingRoleId =
    (process.env.WAR_ALERTS_DEFENSE_PING_ROLE_ID || "").trim() || undefined;
  const intervalMs = Number(process.env.WAR_ALERTS_INTERVAL_MS || "60000");

  const enabled =
    process.env.WAR_ALERTS_ENABLED === "1" ||
    (process.env.WAR_ALERTS_ENABLED || "").toLowerCase() === "true";

  return {
    enabled,
    apiKey,
    allianceId,
    guildId,
    offenseChannelId,
    defenseChannelId,
    defensePingRoleId,
    intervalMs,
  };
}

export function startWarAlertsFromEnv(client: Client): void {
  const {
    enabled,
    apiKey,
    allianceId,
    guildId,
    offenseChannelId,
    defenseChannelId,
    defensePingRoleId,
    intervalMs,
  } = getEnv();

  if (!enabled) {
    console.log("[war-alerts] disabled via WAR_ALERTS_ENABLED");
    return;
  }

  if (!apiKey) {
    console.warn(
      "[war-alerts] no PNW API key set (PNW_GRAPH_KEY / PNW_API_KEY / PNW_SERVICE_API_KEY / PNW_DEFAULT_API_KEY), cannot start war alerts.",
    );
    return;
  }
  if (!allianceId || !guildId || !offenseChannelId || !defenseChannelId) {
    console.warn(
      "[war-alerts] missing config. Need WAR_ALERTS_AID, WAR_ALERTS_GUILD_ID, WAR_ALERTS_OFFENSE_CHANNEL_ID, WAR_ALERTS_DEFENSE_CHANNEL_ID.",
    );
    return;
  }

  console.log(
    "[war-alerts] starting poller for AID",
    allianceId,
    "guild",
    guildId,
    "interval",
    intervalMs,
  );

  async function pollOnce() {
    try {
      const wars = await fetchWars(apiKey);

      const activeWars = wars.filter(
        (w) =>
          w.winner_id === "0" &&
          (w.att_alliance_id === allianceId ||
            w.def_alliance_id === allianceId),
      );

      if (activeWars.length === 0) {
        return;
      }

      const offenseChannelRaw = await client.channels
        .fetch(offenseChannelId)
        .catch(() => null);
      const defenseChannelRaw = await client.channels
        .fetch(defenseChannelId)
        .catch(() => null);

      const offenseChannel = isTextChannel(offenseChannelRaw)
        ? offenseChannelRaw
        : null;
      const defenseChannel = isTextChannel(defenseChannelRaw)
        ? defenseChannelRaw
        : null;

      if (!offenseChannel || !defenseChannel) {
        console.warn(
          "[war-alerts] offense/defense channels not found or not text-based.",
        );
        return;
      }

      for (const war of activeWars) {
        const isOffense = war.att_alliance_id === allianceId;
        const isDefense = war.def_alliance_id === allianceId;
        const key = `${guildId}:${war.id}`;

        const [attMil, defMil] = await Promise.all([
          fetchNationMilitary(apiKey, war.att_id),
          fetchNationMilitary(apiKey, war.def_id),
        ]);

        const embed = buildWarEmbed(war, allianceId, attMil, defMil);
        const components = buildComponents(war.id);
        const channel = isOffense ? offenseChannel : defenseChannel;

        const existing = warMessageMap.get(key);
        if (!existing) {
          const content =
            isDefense && defensePingRoleId
              ? `<@&${defensePingRoleId}> New defensive war started!`
              : undefined;

          const msg = await channel.send({
            content,
            embeds: [embed],
            components,
          });

          warMessageMap.set(key, {
            warId: war.id,
            channelId: channel.id,
            messageId: msg.id,
            isDefensive: isDefense,
          });
        } else {
          try {
            const msg = await channel.messages.fetch(existing.messageId);
            await msg.edit({ embeds: [embed], components });
          } catch {
            // message missing; recreate next poll
            warMessageMap.delete(key);
          }
        }

        // Auto-open war room for defensive wars where we are the defender
        if (isDefense) {
          await ensureAutoWarRoomForDefense(client, guildId, war);
        }
      }
    } catch (err) {
      console.error("[war-alerts] poll error", err);
    }
  }

  void pollOnce();
  setInterval(() => {
    void pollOnce();
  }, intervalMs);
}

// ---- button handler ----

export async function handleWarButtonInteraction(
  interaction: ButtonInteraction,
): Promise<boolean> {
  const cid = interaction.customId || "";
  if (!cid.startsWith("war:")) return false;

  const parts = cid.split(":");
  const action = parts[1];
  const warId = parts[2];

  if (action !== "refresh" || !warId) {
    return false;
  }

  const { apiKey, allianceId } = getEnv();

  if (!apiKey || !allianceId) {
    await interaction.reply({
      content: "War alerts are not configured for this bot.",
      ephemeral: true,
    });
    return true;
  }

  await interaction.deferUpdate();

  try {
    const wars = await fetchWars(apiKey);
    const war = wars.find((w) => w.id === warId);
    if (!war) {
      const embed = new EmbedBuilder()
        .setColor(0x95a5a6)
        .setTitle(`⚔️ War #${warId}`)
        .setDescription(
          "This war is no longer active or could not be found in the latest results.",
        )
        .setTimestamp(new Date());

      await interaction.editReply({ embeds: [embed], components: [] });
      return true;
    }

    const [attMil, defMil] = await Promise.all([
      fetchNationMilitary(apiKey, war.att_id),
      fetchNationMilitary(apiKey, war.def_id),
    ]);

    const embed = buildWarEmbed(war, allianceId, attMil, defMil);
    const components = buildComponents(war.id);

    await interaction.editReply({ embeds: [embed], components });
    return true;
  } catch (err) {
    console.error("[war-alerts] refresh button failed", err);
    try {
      await interaction.followUp({
        content: "Failed to refresh war details.",
        ephemeral: true,
      });
    } catch {
      // ignore
    }
    return true;
  }
}
