// src/commands/warplan.ts

import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  AttachmentBuilder,
  PermissionFlagsBits,
  ChannelType,
  type CategoryChannel,
  type TextChannel,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Colors,
  type User,
} from "discord.js";
import ExcelJS from "exceljs";
import { fetch } from "undici";
import { fetchActiveWars, type WarRecord } from "../pnw/wars.js";
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

// War room DB row — mirror of warroom.ts
interface WarRoomRow {
  id: string;
  guild_id: string;
  channel_id: string;
  control_message_id: string | null;
  name: string;
  created_by_id: string;
  target_nation_id: number;
  target_nation_name: string;
  notes: string | null;
  member_ids: string[];
  created_at: Date;
}

interface DossierInfo {
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
}

const WAR_CATEGORY_NAME = "WAR ROOMS";
const warplanPlans = new Map<number, WarplanPlan>();
let nextPlanId = 1;

// ────────────────────────────────────────────────
// Slash command definition
// ────────────────────────────────────────────────

export const builder = new SlashCommandBuilder()
  .setName("warplan")
  .setDescription("War planning helper using the Blitz spreadsheet format.")
  // perms are managed via /command_roles, so no hard gate here
  .setDMPermission(false)
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
  const pnwKey =
    process.env.PNW_API_KEY && process.env.PNW_API_KEY.trim().length > 0
      ? process.env.PNW_API_KEY.trim()
      : process.env.PNW_KEY && process.env.PNW_KEY.trim().length > 0
        ? process.env.PNW_KEY.trim()
        : process.env.PNW_DEFAULT_API_KEY &&
            process.env.PNW_DEFAULT_API_KEY.trim().length > 0
          ? process.env.PNW_DEFAULT_API_KEY.trim()
          : process.env.PNW_SERVICE_API_KEY &&
              process.env.PNW_SERVICE_API_KEY.trim().length > 0
            ? process.env.PNW_SERVICE_API_KEY.trim()
            : null;

  if (autoEnrich && pnwKey) {
    const uniqueIds = Array.from(
      new Set(rowsWithNationId.map((r) => r.nationId!).filter(Boolean)),
    );

    for (const id of uniqueIds) {
      try {
        const stats = await fetchNationStats(id, pnwKey);
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
        // Not in headers currently; skip or add a custom column if needed.
      }

      excelRow.commit();
    }
  } else if (autoEnrich && !pnwKey) {
    console.warn(
      "[warplan] auto_enrich requested but no PNW key env set (checked PNW_API_KEY, PNW_KEY, PNW_DEFAULT_API_KEY, PNW_SERVICE_API_KEY).",
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

      const attackerNationIds = parseAttackerNationIds(row);
      const attackersLabel = attackerNationIds.length
        ? attackerNationIds.map((id) => `#${id}`).join(", ")
        : "—";

      const dossier: DossierInfo | null = stats
        ? {
            score: stats.score ?? undefined,
            cities: stats.cities ?? undefined,
            soldiers: stats.soldiers ?? undefined,
            tanks: stats.tanks ?? undefined,
            aircraft: stats.aircraft ?? undefined,
            ships: stats.ships ?? undefined,
            missiles: stats.missiles ?? undefined,
            nukes: stats.nukes ?? undefined,
            beigeTurns: stats.beigeTurnsLeft ?? undefined,
            allianceName: stats.allianceName ?? undefined,
          }
        : null;

      let offense: WarRecord[] = [];
      let defense: WarRecord[] = [];
      try {
        const wars = await fetchActiveWars(nationId);
        offense = wars.offense;
        defense = wars.defense;
      } catch (err) {
        console.error("[warplan] fetchActiveWars failed for", nationId, err);
      }

      const rowForEmbed: WarRoomRow = {
        id: "0",
        guild_id: guild.id,
        channel_id: channel.id,
        control_message_id: null,
        name: nationName,
        created_by_id: interaction.user.id,
        target_nation_id: nationId,
        target_nation_name: nationName,
        notes: null,
        member_ids: [interaction.user.id],
        created_at: new Date(),
      };

      const embed = buildControlEmbed(
        rowForEmbed,
        interaction.user,
        dossier,
        offense,
        defense,
        attackersLabel,
      );

      const msg = await channel.send({
        embeds: [embed],
        components: [buildControlRow()],
      });

      try {
        await msg.pin();
      } catch {
        // ignore pin errors
      }

      // Insert DB record so /warroom buttons work
      try {
        await insertWarRoom({
          guildId: rowForEmbed.guild_id,
          channelId: rowForEmbed.channel_id,
          controlMessageId: msg.id,
          name: rowForEmbed.name,
          createdById: rowForEmbed.created_by_id,
          targetNationId: rowForEmbed.target_nation_id,
          targetNationName: rowForEmbed.target_nation_name,
          notes: rowForEmbed.notes,
          memberIds: rowForEmbed.member_ids,
        });
      } catch (err) {
        console.error(
          "[warplan] Failed to insert war_rooms row for",
          nationId,
          err,
        );
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
      "• Auto-enrich was requested, but no **PNW_API_KEY / PNW_KEY / PNW_DEFAULT_API_KEY / PNW_SERVICE_API_KEY** env was set. All non-required columns are left as-is.\n";
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
    new Set(
      plan.targets.flatMap((t) => t.attackerNationIds),
    ),
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
    const channel = (await guild.channels.fetch(
      target.channelId,
    ).catch(() => null)) as TextChannel | null;
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
// Helpers – Excel parsing
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

    const attacker1 = toOptionalString(row.getCell(19).value);
    const attacker2 = toOptionalString(row.getCell(20).value);
    const attacker3 = toOptionalString(row.getCell(21).value);

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

// ────────────────────────────────────────────────
// Helpers – PnW API + war room embed
// ────────────────────────────────────────────────

async function fetchNationStats(
  id: number,
  apiKey: string,
): Promise<EnrichedNationStats | null> {
  const base =
    (process.env.PNW_API_BASE_REST || "https://politicsandwar.com/api").trim();
  const url = `${base.replace(/\/+$/, "")}/nation/id=${id}/&key=${encodeURIComponent(
    apiKey,
  )}`;

  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      console.error("[warplan] REST /nation HTTP", res.status, "for", id);
      return null;
    }
    const d: any = await res.json().catch(() => null);
    if (!d || d.success === false) {
      console.error("[warplan] REST /nation error payload for", id, d);
      return null;
    }

    const num = (v: any): number | null => {
      if (v === null || v === undefined) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    const allianceName =
      typeof d.alliance === "string" && d.alliance !== "0" ? d.alliance : null;
    const alliancePosition =
      typeof d.alliance_position === "string" ? d.alliance_position : null;
    const warPolicy =
      typeof d.war_policy === "string" ? d.war_policy : null;
    const color = typeof d.color === "string" ? d.color : null;

    return {
      id: num(d.nationid) ?? id,
      name: String(d.nation_name ?? d.nation ?? `Nation ${id}`),
      allianceName,
      alliancePosition,
      warPolicy,
      color,
      cities: num(d.cities),
      score: num(d.score),
      beigeTurnsLeft: num(d.beige_turns_left ?? d.beige_turns),
      offensiveWars: null,
      defensiveWars: null,
      soldiers: num(d.soldiers),
      tanks: num(d.tanks),
      aircraft: num(d.aircraft),
      ships: num(d.ships),
      missiles: num(d.missiles),
      nukes: num(d.nukes),
      spies: num(d.spies),
    };
  } catch (err) {
    console.error("[warplan] REST /nation exception for", id, err);
    return null;
  }
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

function formatWarsBlock(offense: WarRecord[], defense: WarRecord[]): string {
  const slotLine = `🎯 **Slots:** O ${offense.length}/3 • D ${defense.length}/3`;

  const fmtOff = (w: WarRecord) => {
    const enemy = w.defender?.nation_name || `#${w.defender_id}`;
    const started = ago(w.date);
    const turns = (w as any).turns_left ?? "?";
    return [
      `• 💥 vs **${enemy}**`,
      `   ⏱️ ${started} — ⏳ T${turns}`,
      `   🔗 [Open War](https://politicsandwar.com/nation/war/status/war=${w.id}) • [Open Nation](https://politicsandwar.com/nation/id=${w.defender_id}) • [Declare](https://politicsandwar.com/nation/war/declare/id=${w.defender_id})`,
    ].join("\n");
  };
  const fmtDef = (w: WarRecord) => {
    const enemy = w.attacker?.nation_name || `#${w.attacker_id}`;
    const started = ago(w.date);
    const turns = (w as any).turns_left ?? "?";
    return [
      `• 🛡️ vs **${enemy}**`,
      `   ⏱️ ${started} — ⏳ T${turns}`,
      `   🔗 [Open War](https://politicsandwar.com/nation/war/status/war=${w.id}) • [Open Nation](https://politicsandwar.com/nation/id=${w.attacker_id}) • [Declare](https://politicsandwar.com/nation/war/declare/id=${w.attacker_id})`,
    ].join("\n");
  };

  const oBlock = offense.length ? offense.map(fmtOff).join("\n\n") : "*None*";
  const dBlock = defense.length ? defense.map(fmtDef).join("\n\n") : "*None*";

  return [slotLine, "", `🗡️ **Offense**`, oBlock, "", `🛡️ **Defense**`, dBlock].join(
    "\n",
  );
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

  if (d.beigeTurns !== undefined) out.push(`🟫 **Beige:** ${d.beigeTurns} turns`);

  return out.length ? out.join("\n") : "No dossier data.";
}

function nationLink(id: number, name?: string | null) {
  const safe = name && name.trim().length ? name.trim() : `Nation #${id}`;
  return `[${safe}](https://politicsandwar.com/nation/id=${id})`;
}

function buildControlEmbed(
  row: WarRoomRow,
  creator: User,
  dossier: DossierInfo | null,
  offense: WarRecord[],
  defense: WarRecord[],
  attackersLabel: string,
): EmbedBuilder {
  const members =
    row.member_ids.length > 0
      ? row.member_ids.map((id) => `<@${id}>`).join("\n")
      : "*none*";

  const descParts: string[] = [
    `🎯 **Target:** ${nationLink(row.target_nation_id, row.target_nation_name)}`,
    `👤 **Created by:** <@${row.created_by_id}>`,
    `⚔️ **Wars:** O ${offense.length} • D ${defense.length}`,
    "",
    `🗡️ **Assigned attackers (Nation IDs):**`,
    attackersLabel || "—",
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
  ];

  return new EmbedBuilder()
    .setColor(Colors.DarkRed)
    .setTitle(`💥 WAR ROOM — ${row.target_nation_name}`)
    .setDescription(descParts.join("\n"))
    .setFooter({ text: "Gemstone Raider — War Room (via /warplan)" })
    .setTimestamp(row.created_at ?? new Date());
}

function buildControlRow() {
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
      .setCustomId("warroom:editNotes")
      .setLabel("Edit Notes")
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

async function insertWarRoom(row: {
  guildId: string;
  channelId: string;
  controlMessageId: string;
  name: string;
  createdById: string;
  targetNationId: number;
  targetNationName: string;
  notes: string | null;
  memberIds: string[];
}): Promise<WarRoomRow> {
  const { rows } = await query<WarRoomRow>(
    `
    INSERT INTO war_rooms
      (guild_id, channel_id, control_message_id, name, created_by_id,
       target_nation_id, target_nation_name, notes, member_ids)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    RETURNING *
  `,
    [
      row.guildId,
      row.channelId,
      row.controlMessageId,
      row.name,
      row.createdById,
      row.targetNationId,
      row.targetNationName,
      row.notes,
      row.memberIds,
    ],
  );
  return rows[0];
}

// ────────────────────────────────────────────────
// Helpers – misc
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

const command: Command = {
  data: builder,
  execute: run,
};

export default command;
