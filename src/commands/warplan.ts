// src/commands/warplan.ts

import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  AttachmentBuilder,
  PermissionFlagsBits,
  ChannelType,
  type CategoryChannel,
  type TextChannel,
} from "discord.js";
import ExcelJS from "exceljs";
import { fetch } from "undici";
import type { Command } from "../types/command.js";
import { query } from "../data/db.js";

const BLITZ_HEADERS = [
  "Nation",
  "NationID",
  "Alliance",
  "Alliance Position",
  "War Policy",
  "Color",
  "Cities",
  "Score",
  "War Range",
  "Beige Turns Left",
  "Offensive Wars",
  "Defensive Wars",
  "Soldiers",
  "Tanks",
  "Planes",
  "Ships",
  "Missiles",
  "Nukes",
  "Spies",
  "Attacker 1",
  "Attacker 2",
  "Attacker 3",
] as const;

type BlitzHeader = (typeof BLITZ_HEADERS)[number];

interface ParsedWarRow {
  nation: string;
  nationId: number | null;
  alliance: string | null;
  attacker1: string | null;
  attacker2: string | null;
  attacker3: string | null;
  rowNumber: number;
}

interface EnrichedNationStats {
  id: number;
  name: string;
  allianceName: string | null;
  alliancePosition: string | null;
  warPolicy: string | null;
  color: string | null;
  cities: number | null;
  score: number | null;
  beigeTurnsLeft: number | null;
  offensiveWars: number | null;
  defensiveWars: number | null;
  soldiers: number | null;
  tanks: number | null;
  aircraft: number | null;
  ships: number | null;
  missiles: number | null;
  nukes: number | null;
  spies: number | null;
}

interface WarplanTarget {
  nationId: number;
  nationName: string;
  channelId: string;
  attackerNationIds: number[];
}

interface WarplanPlan {
  id: number;
  guildId: string;
  createdBy: string;
  createdAt: number;
  targets: WarplanTarget[];
}

const WAR_CATEGORY_NAME = "WAR ROOMS";
const warplanPlans = new Map<number, WarplanPlan>();
let nextPlanId = 1;

// ────────────────────────────────────────────────
// API helpers
// ────────────────────────────────────────────────

function getPnwKey(): string | null {
  const key =
    (
      process.env.PNW_API_KEY ||
      process.env.PNW_DEFAULT_API_KEY ||
      process.env.PNW_SERVICE_API_KEY ||
      process.env.PNW_KEY ||
      ""
    ).trim();
  return key.length ? key : null;
}

function getPnwRestBase(): string {
  return (process.env.PNW_API_BASE_REST || "https://politicsandwar.com/api").trim();
}

function getPnwGraphBase(): string {
  return (
    process.env.PNW_API_BASE_GRAPHQL ||
    "https://api.politicsandwar.com/graphql"
  ).trim();
}

// REST-based stats, mirroring /warroom’s fetchNationDossier but returning a richer struct
async function fetchNationStats(id: number): Promise<EnrichedNationStats | null> {
  const base = getPnwRestBase();
  const key = getPnwKey();
  if (!key) return null;

  const url = `${base.replace(/\/+$/, "")}/nation/id=${id}/&key=${encodeURIComponent(
    key,
  )}`;

  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      console.error("[warplan] REST HTTP", res.status, "for nation", id);
      return null;
    }

    const d: any = await res.json();
    if (d?.success === false) {
      console.error("[warplan] REST error payload for nation", id, d.error);
      return null;
    }

    const toNum = (v: any): number | null => {
      if (v === null || v === undefined) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    const allianceName =
      typeof d.alliance === "string" && d.alliance !== "0" ? d.alliance : null;

    const warPolicy =
      typeof d.war_policy === "string" && d.war_policy.trim().length
        ? d.war_policy
        : null;

    const color =
      typeof d.color === "string" && d.color.trim().length ? d.color : null;

    const idNum =
      toNum(d.nationid ?? d.nation_id) ?? (Number.isFinite(id) ? id : 0);

    // FIX: PnW REST uses `name` for the nation name.
    const rawName =
      (typeof d.name === "string" && d.name.trim().length
        ? d.name
        : d.nation ?? d.nation_name) ?? `Nation ${id}`;

    return {
      id: idNum,
      name: String(rawName),
      allianceName,
      alliancePosition: null, // REST doesn’t expose this cleanly; leave null
      warPolicy,
      color,
      cities: toNum(d.cities),
      score: toNum(d.score),
      beigeTurnsLeft: toNum(d.beige_turns_left ?? d.beige_turns),
      offensiveWars: toNum(d.offensive_wars),
      defensiveWars: toNum(d.defensive_wars),
      soldiers: toNum(d.soldiers),
      tanks: toNum(d.tanks),
      aircraft: toNum(d.aircraft),
      ships: toNum(d.ships),
      missiles: toNum(d.missiles),
      nukes: toNum(d.nukes),
      spies: toNum(d.spies),
    };
  } catch (err) {
    console.error("[warplan] REST failure for nation", id, err);
    return null;
  }
}

// Minimal GraphQL helper to get member nation IDs for an alliance
async function fetchAllianceNationIds(aid: number): Promise<number[]> {
  const key = getPnwKey();
  if (!key) return [];
  const base = getPnwGraphBase();
  const url = `${base}?api_key=${encodeURIComponent(key)}`;

  const body = {
    // Only fetch id to avoid field-name bullshit
    query: `{ nations(alliance_id:${aid}, first:500) { data { id } } }`,
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error("[warplan] GraphQL HTTP", res.status, "for alliance", aid);
      return [];
    }
    const json: any = await res.json().catch(() => null);
    if (!json || json.errors) {
      console.error(
        "[warplan] GraphQL errors for alliance",
        aid,
        json?.errors,
      );
      return [];
    }
    const arr = json.data?.nations?.data ?? [];
    const ids: number[] = [];
    for (const node of arr) {
      const n = Number(node.id);
      if (Number.isFinite(n) && n > 0) ids.push(n);
    }
    return ids;
  } catch (err) {
    console.error("[warplan] GraphQL failure for alliance", aid, err);
    return [];
  }
}

// ────────────────────────────────────────────────
// Slash command definition
// ────────────────────────────────────────────────

export const builder = new SlashCommandBuilder()
  .setName("warplan")
  .setDescription("War planning helper using the Blitz spreadsheet format.")
  .setDMPermission(false)
  // /warplan template
  .addSubcommand((sub) =>
    sub
      .setName("template")
      .setDescription("Download a blank Blitz warplan sheet.")
      .addStringOption((opt) =>
        opt
          .setName("label")
          .setDescription("Optional label for the sheet name / filename.")
          .setRequired(false),
      ),
  )
  // /warplan import
  .addSubcommand((sub) =>
    sub
      .setName("import")
      .setDescription("Import a filled Blitz warplan sheet (XLSX).")
      .addAttachmentOption((opt) =>
        opt
          .setName("file")
          .setDescription("The completed XLSX file you edited.")
          .setRequired(true),
      )
      .addBooleanOption((opt) =>
        opt
          .setName("preview_only")
          .setDescription(
            "If true, only show a summary + enriched sheet. No war rooms.",
          )
          .setRequired(false),
      )
      .addBooleanOption((opt) =>
        opt
          .setName("auto_enrich")
          .setDescription(
            "If true (default), auto-fill unit stats and other fields from PnW.",
          )
          .setRequired(false),
      )
      .addBooleanOption((opt) =>
        opt
          .setName("create_warrooms")
          .setDescription(
            "Create Discord war rooms for each target (defaults to false).",
          )
          .setRequired(false),
      )
      .addBooleanOption((opt) =>
        opt
          .setName("defer_members")
          .setDescription(
            "If true (default), just create channels now. Use /warplan apply_members later.",
          )
          .setRequired(false),
      ),
  )
  // /warplan apply_members
  .addSubcommand((sub) =>
    sub
      .setName("apply_members")
      .setDescription(
        "Apply attackers from a previous /warplan import into their war rooms.",
      )
      .addIntegerOption((opt) =>
        opt
          .setName("plan_id")
          .setDescription("Plan ID from the /warplan import response.")
          .setRequired(true),
      ),
  )
  // /warplan seed_nations
  .addSubcommand((sub) =>
    sub
      .setName("seed_nations")
      .setDescription(
        "Seed a Blitz warplan sheet from a list of enemy nation IDs.",
      )
      .addStringOption((opt) =>
        opt
          .setName("nation_ids")
          .setDescription(
            "Space- or comma-separated list of PnW Nation IDs to seed as targets.",
          )
          .setRequired(true),
      )
      .addStringOption((opt) =>
        opt
          .setName("label")
          .setDescription(
            "Optional label for the sheet name / filename (e.g. Global Blitz X).",
          )
          .setRequired(false),
      ),
  )
  // /warplan seed_alliance
  .addSubcommand((sub) =>
    sub
      .setName("seed_alliance")
      .setDescription(
        "Seed a Blitz warplan sheet from one or more alliance IDs.",
      )
      .addStringOption((opt) =>
        opt
          .setName("alliance_ids")
          .setDescription(
            "Space- or comma-separated list of PnW Alliance IDs to pull members from.",
          )
          .setRequired(true),
      )
      .addStringOption((opt) =>
        opt
          .setName("label")
          .setDescription(
            "Optional label for the sheet name / filename (e.g. Enemy Coalition A).",
          )
          .setRequired(false),
      ),
  );

export async function run(interaction: ChatInputCommandInteraction) {
  const sub = interaction.options.getSubcommand(true);

  if (sub === "template") {
    await handleTemplate(interaction);
    return;
  }

  if (sub === "import") {
    await handleImport(interaction);
    return;
  }

  if (sub === "apply_members") {
    await handleApplyMembers(interaction);
    return;
  }

  if (sub === "seed_nations") {
    await handleSeedNations(interaction);
    return;
  }

  if (sub === "seed_alliance") {
    await handleSeedAlliance(interaction);
    return;
  }

  await interaction.reply({
    content: "Unknown subcommand for /warplan.",
    ephemeral: true,
  });
}

// ────────────────────────────────────────────────
// /warplan template
// ────────────────────────────────────────────────

async function handleTemplate(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const label = interaction.options.getString("label");
  const workbookBuffer = await createTemplateWorkbook(label ?? undefined);

  const filenameBase =
    label && label.trim().length > 0 ? label.trim() : "Blitz Warplan";
  const safeFilenameBase = filenameBase.replace(/[\\/:*?"<>|]+/g, "_");

  const attachment = new AttachmentBuilder(workbookBuffer, {
    name: `${safeFilenameBase}.xlsx`,
  });

  await interaction.editReply({
    content:
      "Here’s your Blitz warplan template.\n\n" +
      "➡ **Required fields for each target row:**\n" +
      "• **Nation** (can be rough; will be overwritten from PnW)\n" +
      "• **NationID** (PnW Nation ID of the **target**)\n" +
      "• **Attacker 1–3** (PnW Nation IDs of your fighters)\n\n" +
      "All other columns will be auto-filled from the PnW API when you run `/warplan import`.",
    files: [attachment],
  });
}

async function createTemplateWorkbook(label?: string): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheetName =
    label && label.trim().length > 0 ? label.trim() : "Blitz Warplan";

  const sheet = workbook.addWorksheet(sheetName);

  // Header row
  const headerRow = sheet.addRow([...BLITZ_HEADERS]);
  headerRow.font = { bold: true };

  // Notes row (row 2) — merged across all columns
  const noteText =
    "NOTE: Fill one row per TARGET nation. Required columns: Nation, NationID, Attacker 1–3. " +
    "Attacker fields must be **PnW Nation IDs** (not Discord IDs / names). " +
    "All other fields will be auto-filled by the bot from PnW.";
  const noteRow = sheet.addRow([noteText]);
  noteRow.getCell(1).font = { italic: true };
  sheet.mergeCells(2, 1, 2, BLITZ_HEADERS.length);

  // Freeze header + note rows
  sheet.views = [{ state: "frozen", ySplit: 2 }];

  // Auto-size columns
  BLITZ_HEADERS.forEach((header, index) => {
    const col = sheet.getColumn(index + 1);
    col.width = Math.max(12, String(header).length + 2);
  });

  const xlsxData = await workbook.xlsx.writeBuffer();
  const nodeBuffer = Buffer.isBuffer(xlsxData)
    ? xlsxData
    : Buffer.from(xlsxData as ArrayBuffer);
  return nodeBuffer;
}

// ────────────────────────────────────────────────
// /warplan import
// ────────────────────────────────────────────────

async function handleImport(interaction: ChatInputCommandInteraction) {
  const attachment = interaction.options.getAttachment("file", true);
  const previewOnly = interaction.options.getBoolean("preview_only") ?? false;
  let createWarrooms =
    interaction.options.getBoolean("create_warrooms") ?? false;
  let deferMembers = interaction.options.getBoolean("defer_members") ?? true;
  const autoEnrich = interaction.options.getBoolean("auto_enrich") ?? true;

  // If they say preview_only, force no war rooms / members.
  if (previewOnly) {
    createWarrooms = false;
    deferMembers = true;
  }

  await interaction.deferReply({ ephemeral: true });

  const name = attachment.name ?? "";
  const ct = (attachment.contentType ?? "").toLowerCase();

  const looksXlsx =
    name.toLowerCase().endsWith(".xlsx") ||
    ct.includes("application/vnd.openxmlformats-officedocument.spreadsheetml");

  if (!looksXlsx) {
    await interaction.editReply(
      "The attached file doesn’t look like an `.xlsx` Excel file. " +
        "Please export the Blitz sheet as **XLSX** and try again.",
    );
    return;
  }

  // Download file via undici
  const res = await fetch(attachment.url);
  if (!res.ok) {
    await interaction.editReply(
      `I couldn’t download that file from Discord (HTTP ${res.status}). Try re-uploading it.`,
    );
    return;
  }

  const arrayBuffer = await res.arrayBuffer();

  let workbook: ExcelJS.Workbook;
  let sheet: ExcelJS.Worksheet;
  let parsedRows: ParsedWarRow[];
  try {
    const parsed = await loadAndParseWarplanWorkbook(arrayBuffer);
    workbook = parsed.workbook;
    sheet = parsed.sheet;
    parsedRows = parsed.rows;
  } catch (err: any) {
    const msg =
      err && typeof err.message === "string"
        ? err.message
        : "Unknown error while reading the workbook.";
    await interaction.editReply(
      "I couldn’t parse that workbook:\n\n" + "```" + msg + "```",
    );
    return;
  }

  if (!parsedRows.length) {
    await interaction.editReply(
      "I didn’t find any data rows under the header. Make sure you have at least one nation row filled in.",
    );
    return;
  }

  const rowsWithNationId = parsedRows.filter((r) => r.nationId !== null);
  if (!rowsWithNationId.length) {
    await interaction.editReply(
      "I parsed the sheet, but none of the rows have a numeric **NationID**. " +
        "Make sure you’re using real PnW Nation IDs in the NationID column.",
    );
    return;
  }

  // ────────────────────────────────────────────
  // Auto-enrich from PnW (stats, wars, etc.)
  // ────────────────────────────────────────────
  const statsById = new Map<number, EnrichedNationStats>();
  const pnwKey = getPnwKey();

  if (autoEnrich && pnwKey) {
    const uniqueIds = Array.from(
      new Set(rowsWithNationId.map((r) => r.nationId!).filter(Boolean)),
    );
    for (const id of uniqueIds) {
      try {
        const stats = await fetchNationStats(id);
        if (stats) {
          statsById.set(id, stats);
        }
      } catch (err) {
        console.error("[warplan] Failed to fetch nation stats for", id, err);
      }
    }

    // Write stats back into the workbook columns
    const colIndex = (header: BlitzHeader) =>
      BLITZ_HEADERS.indexOf(header) + 1;

    for (const row of parsedRows) {
      if (!row.nationId) continue;
      const stats = statsById.get(row.nationId);
      if (!stats) continue;

      const excelRow = sheet.getRow(row.rowNumber);

      excelRow.getCell(colIndex("Nation")).value = stats.name;
      excelRow.getCell(colIndex("NationID")).value = stats.id;
      if (stats.allianceName !== null) {
        excelRow.getCell(colIndex("Alliance")).value = stats.allianceName;
      }
      if (stats.alliancePosition !== null) {
        excelRow.getCell(colIndex("Alliance Position")).value =
          stats.alliancePosition;
      }
      if (stats.warPolicy !== null) {
        excelRow.getCell(colIndex("War Policy")).value = stats.warPolicy;
      }
      if (stats.color !== null) {
        excelRow.getCell(colIndex("Color")).value = stats.color;
      }
      if (stats.cities !== null) {
        excelRow.getCell(colIndex("Cities")).value = stats.cities;
      }
      if (stats.score !== null) {
        excelRow.getCell(colIndex("Score")).value = stats.score;
        // War range (rough) based on score
        const minScore = Math.round(stats.score * 0.75 * 100) / 100;
        const maxScore = Math.round(stats.score * 1.75 * 100) / 100;
        excelRow.getCell(colIndex("War Range")).value = `${minScore} - ${maxScore}`;
      }
      if (stats.beigeTurnsLeft !== null) {
        excelRow.getCell(colIndex("Beige Turns Left")).value =
          stats.beigeTurnsLeft;
      }
      if (stats.offensiveWars !== null) {
        excelRow.getCell(colIndex("Offensive Wars")).value =
          stats.offensiveWars;
      }
      if (stats.defensiveWars !== null) {
        excelRow.getCell(colIndex("Defensive Wars")).value =
          stats.defensiveWars;
      }
      if (stats.soldiers !== null) {
        excelRow.getCell(colIndex("Soldiers")).value = stats.soldiers;
      }
      if (stats.tanks !== null) {
        excelRow.getCell(colIndex("Tanks")).value = stats.tanks;
      }
      if (stats.aircraft !== null) {
        excelRow.getCell(colIndex("Planes")).value = stats.aircraft;
      }
      if (stats.ships !== null) {
        excelRow.getCell(colIndex("Ships")).value = stats.ships;
      }
      if (stats.missiles !== null) {
        excelRow.getCell(colIndex("Missiles")).value = stats.missiles;
      }
      if (stats.nukes !== null) {
        excelRow.getCell(colIndex("Nukes")).value = stats.nukes;
      }
      if (stats.spies !== null) {
        excelRow.getCell(colIndex("Spies")).value = stats.spies;
      }

      excelRow.commit();
    }
  } else if (autoEnrich && !pnwKey) {
    console.warn(
      "[warplan] auto_enrich requested but no PNW_API_KEY / PNW_DEFAULT_API_KEY / PNW_SERVICE_API_KEY set.",
    );
  }

  // ────────────────────────────────────────────
  // Build Discord preview text
  // ────────────────────────────────────────────

  const withAttackers = parsedRows.filter((row) => hasAnyAttacker(row));

  const previewSource =
    withAttackers.length > 0 ? withAttackers : parsedRows;

  const lines: string[] = previewSource.slice(0, 25).map((row, idx) => {
    const targetLabel = row.nationId
      ? `${row.nation} [${row.nationId}]`
      : row.nation || `Row ${row.rowNumber}`;
    const attackerIds = parseAttackerNationIds(row);
    const attackersLabel = attackerIds.length
      ? attackerIds.map((id) => `#${id}`).join(", ")
      : "—";
    const alliance = row.alliance ? ` (${row.alliance})` : "";
    return `${idx + 1}. **${targetLabel}**${alliance} ← ${attackersLabel}`;
  });

  const extra =
    Math.max(
      0,
      (withAttackers.length || parsedRows.length) - lines.length,
    ) || 0;

  const numericRows = rowsWithNationId.length;
  const attackerRows = withAttackers.length;

  // ────────────────────────────────────────────
  // Optional: create war rooms + store plan
  // ────────────────────────────────────────────

  let createdChannels = 0;
  let plan: WarplanPlan | null = null;
  let planIdText = "";

  if (createWarrooms && interaction.guild) {
    const guild = interaction.guild;
    const category = await ensureWarCategory(guild);

    const targetsForRooms = parsedRows.filter((row) => {
      return row.nationId && parseAttackerNationIds(row).length > 0;
    });

    const warTargets: WarplanTarget[] = [];

    for (const row of targetsForRooms) {
      const nationId = row.nationId!;
      const stats = statsById.get(nationId);
      const nationName =
        stats?.name || row.nation || `Target ${nationId}`;
      const slug = slugifyName(nationName);
      const baseName = `war-${slug}-${nationId}`;
      const channelName =
        baseName.length > 90 ? baseName.slice(0, 90) : baseName;

      const channel = (await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: category.id,
      })) as TextChannel;

      createdChannels++;

      const statLines: string[] = [];
      if (stats) {
        statLines.push(
          `Score: **${stats.score ?? "?"}** | Cities: **${stats.cities ?? "?"}** | Color: **${stats.color ?? "?"}**`,
        );
        statLines.push(
          `Soldiers: **${stats.soldiers ?? "?"}**, Tanks: **${stats.tanks ?? "?"}**, Planes: **${stats.aircraft ?? "?"}**, Ships: **${stats.ships ?? "?"}**`,
        );
        statLines.push(
          `Missiles: **${stats.missiles ?? "?"}**, Nukes: **${stats.nukes ?? "?"}**, Spies: **${stats.spies ?? "?"}**`,
        );
        statLines.push(
          `Off Wars: **${stats.offensiveWars ?? "?"}**, Def Wars: **${stats.defensiveWars ?? "?"}**, Beige Left: **${stats.beigeTurnsLeft ?? "?"}**`,
        );
      }

      const attackerNationIds = parseAttackerNationIds(row);
      const attackersLabel = attackerNationIds.length
        ? attackerNationIds.map((id) => `#${id}`).join(", ")
        : "—";

      let body =
        `**War Room:** ${nationName} [${nationId}]\n` +
        `Alliance: **${stats?.allianceName ?? row.alliance ?? "?"}**\n\n`;

      if (statLines.length) {
        body += statLines.join("\n") + "\n\n";
      }

      body += `**Assigned attackers (Nation IDs):** ${attackersLabel}\n`;

      const msg = await channel.send(body);
      try {
        await msg.pin();
      } catch {
        // ignore pin errors
      }

      warTargets.push({
        nationId,
        nationName,
        channelId: channel.id,
        attackerNationIds,
      });
    }

    if (warTargets.length > 0) {
      const id = nextPlanId++;
      plan = {
        id,
        guildId: interaction.guildId!,
        createdBy: interaction.user.id,
        createdAt: Date.now(),
        targets: warTargets,
      };
      warplanPlans.set(id, plan);
      planIdText = `\n\nPlan ID for later member application: **${id}**\nUse \`/warplan apply_members plan_id:${id}\` after linking nations.`;
    }
  }

  // ────────────────────────────────────────────
  // Export updated workbook
  // ────────────────────────────────────────────

  const xlsxData = await workbook.xlsx.writeBuffer();
  const nodeBuffer = Buffer.isBuffer(xlsxData)
    ? xlsxData
    : Buffer.from(xlsxData as ArrayBuffer);

  const originalName = attachment.name ?? "warplan.xlsx";
  const base =
    originalName.toLowerCase().endsWith(".xlsx")
      ? originalName.slice(0, -5)
      : originalName;
  const outName = `${base}-enriched.xlsx`.replace(/[\\/:*?"<>|]+/g, "_");

  const outAttachment = new AttachmentBuilder(nodeBuffer, {
    name: outName,
  });

  // ────────────────────────────────────────────
  // Final reply
  // ────────────────────────────────────────────

  let content = "";
  content += `Parsed **${parsedRows.length}** row(s) total.\n`;
  content += `• Rows with numeric NationID: **${numericRows}**\n`;
  content += `• Rows with at least one attacker: **${attackerRows}**\n`;

  if (autoEnrich && pnwKey) {
    content += `• Auto-enriched from PnW for **${statsById.size}** nation(s).\n`;
  } else if (autoEnrich && !pnwKey) {
    content +=
      "• Auto-enrich was requested, but no **PNW_API_KEY / PNW_DEFAULT_API_KEY / PNW_SERVICE_API_KEY** env was set. All non-required columns are left as-is.\n";
  }

  if (createdChannels > 0) {
    content += `\nCreated **${createdChannels}** war room channel(s).`;
  } else if (createWarrooms) {
    content +=
      "\nNo war rooms were created (no rows had both NationID and at least one attacker).";
  }

  if (plan && deferMembers) {
    content +=
      "\n\nMembers have **not** been added yet. When you’re ready, run:\n" +
      `\`/warplan apply_members plan_id:${plan.id}\``;
  } else if (plan && !deferMembers) {
    content +=
      "\n\nUse `/warplan apply_members` to sync attackers into channels once nations are linked.";
  }

  if (previewOnly) {
    content +=
      "\n\nPreview only – no channels or permissions were changed.";
  }

  content +=
    "\n\n**Preview of assignments:**\n" +
    (lines.join("\n") || "*No rows to display.*");
  if (extra > 0) {
    content += `\n… and ${extra} more row(s).`;
  }

  content += planIdText;

  await interaction.editReply({
    content,
    files: [outAttachment],
  });
}

// ────────────────────────────────────────────────
// /warplan apply_members
// ────────────────────────────────────────────────

async function handleApplyMembers(
  interaction: ChatInputCommandInteraction,
) {
  const planId = interaction.options.getInteger("plan_id", true);

  await interaction.deferReply({ ephemeral: true });

  const plan = warplanPlans.get(planId);
  if (!plan || plan.guildId !== interaction.guildId) {
    await interaction.editReply(
      "I couldn’t find that plan ID in memory for this server. " +
        "Plans are kept in-memory only, so you may need to re-run `/warplan import`.",
    );
    return;
  }

  if (!interaction.guild) {
    await interaction.editReply(
      "This command can only be used inside a server.",
    );
    return;
  }

  const guild = interaction.guild;

  // Collect all attacker nation IDs across the plan
  const allAttackerIds = Array.from(
    new Set(plan.targets.flatMap((t) => t.attackerNationIds)),
  );
  if (!allAttackerIds.length) {
    await interaction.editReply(
      "This plan has no attacker Nation IDs to map. Make sure Attacker 1–3 columns contain PnW Nation IDs.",
    );
    return;
  }

  // Resolve PnW nation IDs -> Discord user IDs via nation_links table
  const nationToDiscord = await mapNationIdsToDiscordUsers(allAttackerIds);

  let totalChannelsTouched = 0;
  let totalMembersAdded = 0;

  for (const target of plan.targets) {
    const channel = (await guild.channels
      .fetch(target.channelId)
      .catch(() => null)) as TextChannel | null;
    if (!channel) continue;

    totalChannelsTouched++;

    for (const nationId of target.attackerNationIds) {
      const discordUserId = nationToDiscord.get(nationId);
      if (!discordUserId) continue;

      const member = await guild.members
        .fetch(discordUserId)
        .catch(() => null);
      if (!member) continue;

      try {
        await channel.permissionOverwrites.edit(member, {
          ViewChannel: true,
          SendMessages: true,
        });
        totalMembersAdded++;
      } catch (err) {
        console.error(
          "[warplan] Failed to edit overwrites for",
          discordUserId,
          "on channel",
          channel.id,
          err,
        );
      }
    }
  }

  if (!totalChannelsTouched) {
    await interaction.editReply(
      "I couldn’t find any of the war room channels from that plan. " +
        "They may have been deleted or renamed.",
    );
    return;
  }

  if (!totalMembersAdded) {
    await interaction.editReply(
      "No members were added to any channels.\n\n" +
        "This usually means either:\n" +
        "• Your attackers’ Nation IDs aren’t linked via `/link_nation`, or\n" +
        "• The nation_links table/entries aren’t present yet.\n\n" +
        "Once nations are linked to Discord accounts, re-run this command.",
    );
    return;
  }

  await interaction.editReply(
    `Applied attackers to war rooms.\n\n` +
      `• Channels touched: **${totalChannelsTouched}**\n` +
      `• Member-permissions added: **${totalMembersAdded}**`,
  );
}

// ────────────────────────────────────────────────
// /warplan seed_nations
// ────────────────────────────────────────────────

async function handleSeedNations(interaction: ChatInputCommandInteraction) {
  const raw = interaction.options.getString("nation_ids", true);
  const label = interaction.options.getString("label");

  const ids = parseIdList(raw);
  if (!ids.length) {
    await interaction.reply({
      content:
        "I couldn’t parse any Nation IDs. Use a space- or comma-separated list of numbers.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const statsList: EnrichedNationStats[] = [];
  for (const id of ids) {
    const stats = await fetchNationStats(id);
    if (stats) statsList.push(stats);
  }

  if (!statsList.length) {
    await interaction.editReply(
      "I couldn’t fetch any nation data for those IDs. Double-check they’re valid PnW Nation IDs.",
    );
    return;
  }

  // Sort by score desc, then by id
  statsList.sort((a, b) => {
    const sa = a.score ?? 0;
    const sb = b.score ?? 0;
    if (sb !== sa) return sb - sa;
    return a.id - b.id;
  });

  const note =
    "NOTE: Seeded from explicit Nation IDs. Fill Attacker 1–3 with your fighter Nation IDs, then upload this sheet via `/warplan import`.";

  const buffer = await buildWorkbookFromStats(statsList, label ?? undefined, note);
  const filenameBase =
    label && label.trim().length > 0 ? label.trim() : "Blitz Warplan";
  const safeFilenameBase = filenameBase.replace(/[\\/:*?"<>|]+/g, "_");

  const attachment = new AttachmentBuilder(buffer, {
    name: `${safeFilenameBase}-seed-nations.xlsx`,
  });

  await interaction.editReply({
    content:
      `Seeded Blitz sheet for **${statsList.length}** nation(s).\n` +
      "Fill **Attacker 1–3** with your fighter Nation IDs, then upload via `/warplan import` when you’re ready to blitz.",
    files: [attachment],
  });
}

// ────────────────────────────────────────────────
// /warplan seed_alliance
// ────────────────────────────────────────────────

async function handleSeedAlliance(interaction: ChatInputCommandInteraction) {
  const raw = interaction.options.getString("alliance_ids", true);
  const label = interaction.options.getString("label");

  const aids = parseIdList(raw);
  if (!aids.length) {
    await interaction.reply({
      content:
        "I couldn’t parse any Alliance IDs. Use a space- or comma-separated list of numbers.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const allNationIds = new Set<number>();
  for (const aid of aids) {
    const ids = await fetchAllianceNationIds(aid);
    ids.forEach((n) => allNationIds.add(n));
  }

  const nationIds = Array.from(allNationIds);
  if (!nationIds.length) {
    await interaction.editReply(
      "I couldn’t find any nations for those alliance IDs.",
    );
    return;
  }

  const statsList: EnrichedNationStats[] = [];
  for (const id of nationIds) {
    const stats = await fetchNationStats(id);
    if (stats) statsList.push(stats);
  }

  if (!statsList.length) {
    await interaction.editReply(
      "I couldn’t fetch nation data for members of those alliances.",
    );
    return;
  }

  // Sort by score desc
  statsList.sort((a, b) => {
    const sa = a.score ?? 0;
    const sb = b.score ?? 0;
    if (sb !== sa) return sb - sa;
    return a.id - b.id;
  });

  const aidsLabel = aids.join(", ");
  const note =
    `NOTE: Seeded from alliance ID(s): ${aidsLabel}. Each row is an enemy nation. ` +
    "Fill Attacker 1–3 with your fighter Nation IDs, then upload this sheet via `/warplan import`.";

  const buffer = await buildWorkbookFromStats(statsList, label ?? undefined, note);
  const filenameBase =
    label && label.trim().length > 0
      ? label.trim()
      : `Blitz Warplan (AIDs ${aidsLabel})`;
  const safeFilenameBase = filenameBase.replace(/[\\/:*?"<>|]+/g, "_");

  const attachment = new AttachmentBuilder(buffer, {
    name: `${safeFilenameBase}-seed-alliance.xlsx`,
  });

  await interaction.editReply({
    content:
      `Seeded Blitz sheet for **${statsList.length}** nation(s) across alliance ID(s): **${aidsLabel}**.\n` +
      "Fill **Attacker 1–3** with your fighter Nation IDs, then upload via `/warplan import` when you’re ready to blitz.",
    files: [attachment],
  });
}

// ────────────────────────────────────────────────
// Helpers for seeding workbooks
// ────────────────────────────────────────────────

async function buildWorkbookFromStats(
  statsList: EnrichedNationStats[],
  label: string | undefined,
  noteText: string,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheetName =
    label && label.trim().length > 0 ? label.trim() : "Blitz Warplan";

  const sheet = workbook.addWorksheet(sheetName);

  const headerRow = sheet.addRow([...BLITZ_HEADERS]);
  headerRow.font = { bold: true };

  const noteRow = sheet.addRow([noteText]);
  noteRow.getCell(1).font = { italic: true };
  sheet.mergeCells(2, 1, 2, BLITZ_HEADERS.length);

  sheet.views = [{ state: "frozen", ySplit: 2 }];

  const colIndex = (header: BlitzHeader) =>
    BLITZ_HEADERS.indexOf(header) + 1;

  for (const stats of statsList) {
    const row = sheet.addRow([]);

    row.getCell(colIndex("Nation")).value = stats.name;
    row.getCell(colIndex("NationID")).value = stats.id;

    if (stats.allianceName !== null) {
      row.getCell(colIndex("Alliance")).value = stats.allianceName;
    }
    if (stats.alliancePosition !== null) {
      row.getCell(colIndex("Alliance Position")).value =
        stats.alliancePosition;
    }
    if (stats.warPolicy !== null) {
      row.getCell(colIndex("War Policy")).value = stats.warPolicy;
    }
    if (stats.color !== null) {
      row.getCell(colIndex("Color")).value = stats.color;
    }
    if (stats.cities !== null) {
      row.getCell(colIndex("Cities")).value = stats.cities;
    }
    if (stats.score !== null) {
      row.getCell(colIndex("Score")).value = stats.score;
      const minScore = Math.round(stats.score * 0.75 * 100) / 100;
      const maxScore = Math.round(stats.score * 1.75 * 100) / 100;
      row.getCell(colIndex("War Range")).value = `${minScore} - ${maxScore}`;
    }
    if (stats.beigeTurnsLeft !== null) {
      row.getCell(colIndex("Beige Turns Left")).value =
        stats.beigeTurnsLeft;
    }
    if (stats.offensiveWars !== null) {
      row.getCell(colIndex("Offensive Wars")).value =
        stats.offensiveWars;
    }
    if (stats.defensiveWars !== null) {
      row.getCell(colIndex("Defensive Wars")).value =
        stats.defensiveWars;
    }
    if (stats.soldiers !== null) {
      row.getCell(colIndex("Soldiers")).value = stats.soldiers;
    }
    if (stats.tanks !== null) {
      row.getCell(colIndex("Tanks")).value = stats.tanks;
    }
    if (stats.aircraft !== null) {
      row.getCell(colIndex("Planes")).value = stats.aircraft;
    }
    if (stats.ships !== null) {
      row.getCell(colIndex("Ships")).value = stats.ships;
    }
    if (stats.missiles !== null) {
      row.getCell(colIndex("Missiles")).value = stats.missiles;
    }
    if (stats.nukes !== null) {
      row.getCell(colIndex("Nukes")).value = stats.nukes;
    }
    if (stats.spies !== null) {
      row.getCell(colIndex("Spies")).value = stats.spies;
    }

    row.commit();
  }

  BLITZ_HEADERS.forEach((header, index) => {
    const col = sheet.getColumn(index + 1);
    col.width = Math.max(12, String(header).length + 2);
  });

  const xlsxData = await workbook.xlsx.writeBuffer();
  const nodeBuffer = Buffer.isBuffer(xlsxData)
    ? xlsxData
    : Buffer.from(xlsxData as ArrayBuffer);
  return nodeBuffer;
}

// ────────────────────────────────────────────────
// Core parsing helpers
// ────────────────────────────────────────────────

async function loadAndParseWarplanWorkbook(arrayBuffer: ArrayBuffer): Promise<{
  workbook: ExcelJS.Workbook;
  sheet: ExcelJS.Worksheet;
  rows: ParsedWarRow[];
}> {
  const workbook = new ExcelJS.Workbook();
  const data = new Uint8Array(arrayBuffer);
  await workbook.xlsx.load(data as any);

  const sheet = workbook.worksheets[0];
  if (!sheet) {
    throw new Error("Workbook has no worksheets.");
  }

  const headerRow = sheet.getRow(1);
  validateHeaderRow(headerRow);

  const results: ParsedWarRow[] = [];

  sheet.eachRow((row: ExcelJS.Row, rowNumber: number) => {
    // Row 1 = header, Row 2 = NOTE row in our template
    if (rowNumber === 1) return;
    if (rowNumber === 2 && isNoteRow(row)) return;

    const nationCell = row.getCell(1);
    const nationRaw = nationCell.value;
    const nation =
      nationRaw === null || nationRaw === undefined
        ? ""
        : String(nationRaw).trim();

    // If row is completely empty (except maybe some junk), skip
    if (!nation) {
      let hasNonEmpty = false;
      row.eachCell(
        { includeEmpty: false },
        (cell: ExcelJS.Cell, colNumber: number) => {
          if (colNumber === 1) return;
          const v = cell.value;
          if (
            v !== null &&
            v !== undefined &&
            String(v).trim().length > 0
          ) {
            hasNonEmpty = true;
          }
        },
      );
      if (!hasNonEmpty) {
        return;
      }
    }

    const nationId = parseOptionalInt(row.getCell(2).value);
    const alliance = toOptionalString(row.getCell(3).value);

    // With Spies column, attackers are now columns 20–22
    const attacker1 = toOptionalString(row.getCell(20).value);
    const attacker2 = toOptionalString(row.getCell(21).value);
    const attacker3 = toOptionalString(row.getCell(22).value);

    results.push({
      nation: nation || "",
      nationId,
      alliance,
      attacker1,
      attacker2,
      attacker3,
      rowNumber,
    });
  });

  return { workbook, sheet: sheet, rows: results };
}

function validateHeaderRow(headerRow: ExcelJS.Row): void {
  const problems: string[] = [];

  BLITZ_HEADERS.forEach((expected: BlitzHeader, index: number) => {
    const cell = headerRow.getCell(index + 1);
    const raw = cell.value;
    const actual =
      raw === null || raw === undefined ? "" : String(raw).trim();

    if (actual !== expected) {
      problems.push(
        `Col ${index + 1}: expected **${expected}** but found **${
          actual || "(blank)"
        }**`,
      );
    }
  });

  if (problems.length > 0) {
    const msg = [
      "The first row doesn’t match the expected Blitz header format.",
      "",
      ...problems,
    ].join("\n");
    throw new Error(msg);
  }
}

function isNoteRow(row: ExcelJS.Row): boolean {
  const v = row.getCell(1).value;
  if (v === null || v === undefined) return false;
  const s = String(v).trim().toUpperCase();
  return s.startsWith("NOTE:");
}

function parseOptionalInt(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function toOptionalString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s.length ? s : null;
}

function hasAnyAttacker(row: ParsedWarRow): boolean {
  return parseAttackerNationIds(row).length > 0;
}

function parseAttackerNationIds(row: ParsedWarRow): number[] {
  const raw = [row.attacker1, row.attacker2, row.attacker3];
  const out: number[] = [];
  for (const val of raw) {
    if (!val) continue;
    const s = String(val).trim();
    if (!s) continue;
    const n = Number(s);
    if (Number.isFinite(n) && n > 0) {
      out.push(n);
    }
  }
  return out;
}

function parseIdList(raw: string): number[] {
  const parts = raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out: number[] = [];
  for (const p of parts) {
    const n = Number(p);
    if (Number.isFinite(n) && n > 0) out.push(n);
  }
  return Array.from(new Set(out));
}

// ────────────────────────────────────────────────
// Misc helpers
// ────────────────────────────────────────────────

function slugifyName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "target"
  );
}

async function ensureWarCategory(
  guild: import("discord.js").Guild,
): Promise<CategoryChannel> {
  const existing = guild.channels.cache.find((c) => {
    return (
      c.type === ChannelType.GuildCategory &&
      c.name.toLowerCase().includes("war") &&
      c.name.toLowerCase().includes("room")
    );
  }) as CategoryChannel | undefined;

  if (existing) return existing;

  const category = (await guild.channels.create({
    name: WAR_CATEGORY_NAME,
    type: ChannelType.GuildCategory,
    permissionOverwrites: [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionFlagsBits.ViewChannel],
      },
      {
        id: guild.ownerId,
        allow: [PermissionFlagsBits.ViewChannel],
      },
    ],
  })) as CategoryChannel;

  return category;
}

async function mapNationIdsToDiscordUsers(
  nationIds: number[],
): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  if (!nationIds.length) return result;

  try {
    const { rows } = await query(
      "SELECT nation_id, discord_user_id FROM nation_links WHERE nation_id = ANY($1)",
      [nationIds],
    );
    for (const row of rows) {
      const nid = Number(row.nation_id);
      const did = String(row.discord_user_id);
      if (Number.isFinite(nid) && did) {
        result.set(nid, did);
      }
    }
  } catch (err) {
    console.error(
      "[warplan] Failed to load nation_links for attackers:",
      err,
    );
  }

  return result;
}

// ────────────────────────────────────────────────
// Command export
// ────────────────────────────────────────────────

const command: Command = {
  data: builder,
  execute: run,
};

export default command;
