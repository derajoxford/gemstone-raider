// src/commands/warplan.ts

import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  AttachmentBuilder,
  PermissionFlagsBits,
} from "discord.js";
import ExcelJS from "exceljs";
import { fetch } from "undici";

// This is the header layout from the Blitz sheet you provided.
// The template we generate will match this exactly, in order.
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

// Slash command definition
export const builder = new SlashCommandBuilder()
  .setName("warplan")
  .setDescription("War planning helper using the Blitz spreadsheet format.")
  // you can remove this if you want roles-only gating; leaving for now
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
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
            "If true, only show a summary. (War room creation can be wired up later.)",
          )
          .setRequired(false),
      ),
  );

// Main command handler
export async function run(interaction: ChatInputCommandInteraction) {
  const sub = interaction.options.getSubcommand(true);

  if (sub === "template") {
    await handleTemplate(interaction);
  } else if (sub === "import") {
    await handleImport(interaction);
  } else {
    await interaction.reply({
      content: "Unknown subcommand for /warplan.",
      ephemeral: true,
    });
  }
}

/**
 * /warplan template
 * Sends an XLSX file that matches the Blitz header layout exactly,
 * plus a helper row explaining what to fill in (NationID + Attacker IDs).
 */
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
      "Here’s your Blitz warplan template.\n" +
      "✅ **Required per target:** Nation, NationID, Attacker 1–3 (PnW nation IDs, numbers only)\n" +
      "Fill it in, then upload it back with `/warplan import`.",
    files: [attachment],
  });
}

/**
 * /warplan import
 * Downloads the attachment, parses rows, and shows a summary.
 * (Right now this is preview-only; we can wire this into war-room creation next.)
 */
async function handleImport(interaction: ChatInputCommandInteraction) {
  const attachment = interaction.options.getAttachment("file", true);
  const previewOnly = interaction.options.getBoolean("preview_only") ?? false;

  await interaction.deferReply({ ephemeral: true });

  if (!attachment.url.endsWith(".xlsx")) {
    await interaction.editReply(
      "The attached file doesn’t look like an `.xlsx` Excel file. Please export the sheet as XLSX and try again.",
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
  const parsedRows = await parseWarplanWorkbook(arrayBuffer);

  if (!parsedRows.length) {
    await interaction.editReply(
      "I didn’t find any valid nation rows. Make sure each target has a **NationID** (number) and re-upload.",
    );
    return;
  }

  const withAttackers = parsedRows.filter(
    (row) => row.attacker1 || row.attacker2 || row.attacker3,
  );

  const lines: string[] = (withAttackers.length ? withAttackers : parsedRows)
    .slice(0, 25) // Discord message safety
    .map((row, idx) => {
      const targetLabel = row.nationId
        ? `${row.nation} [${row.nationId}]`
        : row.nation || `Row ${row.rowNumber}`;
      const attackers =
        [row.attacker1, row.attacker2, row.attacker3].filter(Boolean).join(", ") ||
        "—";
      const alliance = row.alliance ? ` (${row.alliance})` : "";
      return `${idx + 1}. **${targetLabel}**${alliance} ← ${attackers}`;
    });

  const extra = Math.max(
    0,
    (withAttackers.length || parsedRows.length) - lines.length,
  );

  let content = "";
  content += `Parsed **${parsedRows.length}** nation row(s) with a valid NationID.\n`;

  if (!withAttackers.length) {
    content +=
      "\nI didn’t see any attackers filled in yet (Attacker 1–3). I’ll still show the target list below.\n\n";
  } else {
    content += `\nI see **${withAttackers.length}** row(s) with at least one attacker assigned.\n\n`;
  }

  content += lines.join("\n") || "*No rows to display.*";
  if (extra > 0) {
    content += `\n… and ${extra} more row(s).`;
  }

  if (previewOnly) {
    content +=
      "\n\nPreview only – no channels or war rooms have been created yet. We can wire that part next.";
  } else {
    content +=
      "\n\nRight now this is **preview-only**. Once we’re happy with the format, we’ll hook this into automatic war-room creation + optional delayed member assignment.";
  }

  await interaction.editReply({ content });
}

/**
 * Build a workbook that matches the Blitz header layout, plus:
 *  - Row 1: Exact Blitz headers
 *  - Row 2: Helper text describing what to fill in (esp. NationID + attackers)
 */
async function createTemplateWorkbook(label?: string): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheetName =
    label && label.trim().length > 0 ? label.trim() : "Blitz Warplan";

  const sheet = workbook.addWorksheet(sheetName);

  // Header row (MUST stay exactly Blitz headers)
  const headerRow = sheet.addRow([...BLITZ_HEADERS]);
  headerRow.font = { bold: true };

  // Helper row under the header explaining required fields / nation IDs
  const helperValues = BLITZ_HEADERS.map((header): string => {
    switch (header) {
      case "Nation":
        return "REQUIRED → Enemy nation name";
      case "NationID":
        return "REQUIRED → Enemy nation ID (number only, e.g. 246232)";
      case "Attacker 1":
        return "REQUIRED when target is assigned → Your fighter’s nation ID";
      case "Attacker 2":
      case "Attacker 3":
        return "Optional → Extra fighter nation IDs";
      default:
        return "Optional / from export (can leave as-is or blank)";
    }
  });

  const helperRow = sheet.addRow(helperValues);
  helperRow.font = { italic: true, color: { argb: "FF666666" } };

  // Freeze header + helper row
  sheet.views = [{ state: "frozen", ySplit: 2 }];

  // Auto-size columns based on header + helper text
  BLITZ_HEADERS.forEach((header, index) => {
    const headerLen = String(header).length;
    const helperLen = String(helperValues[index] ?? "").length;
    const col = sheet.getColumn(index + 1);
    col.width = Math.max(12, headerLen + 2, helperLen + 2);
  });

  // ExcelJS returns a generic "Buffer" type (ExcelJS.Buffer) which is
  // ArrayBuffer in browser or Node Buffer in Node. We normalize it to
  // a Node Buffer here so Discord's AttachmentBuilder is happy.
  const xlsxData = await workbook.xlsx.writeBuffer();
  const nodeBuffer = Buffer.isBuffer(xlsxData)
    ? xlsxData
    : Buffer.from(xlsxData as ArrayBuffer);

  return nodeBuffer as Buffer;
}

/**
 * Validate that the first row matches the Blitz header layout
 * (at least for all known columns in correct order).
 */
function validateHeaderRow(headerRow: ExcelJS.Row): void {
  const problems: string[] = [];

  BLITZ_HEADERS.forEach((expected: BlitzHeader, index: number) => {
    const cell = headerRow.getCell(index + 1);
    const raw = cell.value;
    const actual =
      raw === null || raw === undefined ? "" : String(raw).trim();

    if (actual !== expected) {
      problems.push(
        `Col ${index + 1}: expected **${expected}** but found **${actual || "(blank)"}**`,
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

/**
 * Parse the Blitz workbook from an ArrayBuffer (from undici fetch).
 * Rows MUST have a valid NationID (number) or they are ignored.
 */
async function parseWarplanWorkbook(
  arrayBuffer: ArrayBuffer,
): Promise<ParsedWarRow[]> {
  const workbook = new ExcelJS.Workbook();

  // ExcelJS can load from a Uint8Array; we cast to any to avoid type gymnastics.
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
    if (rowNumber === 1) return; // skip header row; helper/info rows are filtered below

    const nationCell = row.getCell(1);
    const nationRaw = nationCell.value;
    const nation =
      nationRaw === null || nationRaw === undefined
        ? ""
        : String(nationRaw).trim();

    const nationId = parseOptionalInt(row.getCell(2).value);
    const alliance = toOptionalString(row.getCell(3).value);

    const attacker1 = toOptionalString(row.getCell(19).value);
    const attacker2 = toOptionalString(row.getCell(20).value);
    const attacker3 = toOptionalString(row.getCell(21).value);

    // Ignore any rows that don't have a valid NationID.
    // This:
    //  - lets us safely include helper/instruction rows in the template
    //  - forces your guys to use real PnW nation IDs (no random text-only rows)
    if (nationId === null) {
      return;
    }

    // Also ignore rows that are effectively empty beyond the NationID.
    if (!nation && !alliance && !attacker1 && !attacker2 && !attacker3) {
      return;
    }

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

  return results;
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
