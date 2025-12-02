import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Attachment,
  ChannelType,
  type CategoryChannel,
  type TextChannel,
} from "discord.js";
import * as ExcelJS from "exceljs";

type TargetRow = {
  rowNumber: number;
  nationName: string;
  nationId: number;
  attackers: number[];
};

const HEADER_NATION = "Nation";
const HEADER_NATION_ID = "NationID";
const HEADER_ATTACKERS = ["Attacker 1", "Attacker 2", "Attacker 3"];

// Exact header order matching the sample sheet you sent
const TEMPLATE_HEADERS = [
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
];

async function createTemplateWorkbook(label?: string): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheetName = label && label.trim().length > 0 ? label.trim() : "Warplan";
  const sheet = workbook.addWorksheet(sheetName);

  sheet.addRow(TEMPLATE_HEADERS);

  // Make the header row bold
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };

  // Autosize-ish columns
  TEMPLATE_HEADERS.forEach((header, idx) => {
    const col = sheet.getColumn(idx + 1);
    col.width = Math.max(12, header.length + 2);
  });

  const buffer = (await workbook.xlsx.writeBuffer()) as Buffer;
  return buffer;
}

async function downloadAttachment(attachment: Attachment): Promise<Buffer> {
  const res = await fetch(attachment.url);
  if (!res.ok) {
    throw new Error(`Failed to download attachment: HTTP ${res.status}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function parseWarplanAttachment(
  attachment: Attachment,
): Promise<{ targets: TargetRow[]; warnings: string[] }> {
  const buffer = await downloadAttachment(attachment);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const sheet = workbook.worksheets[0];
  if (!sheet) {
    throw new Error("No worksheet found in the uploaded file.");
  }

  const headerRow = sheet.getRow(1);
  if (!headerRow || headerRow.cellCount === 0) {
    throw new Error("First row appears to be empty. Expected a header row.");
  }

  const headerMap = new Map<string, number>();
  headerRow.eachCell(
    (cell: ExcelJS.Cell, colNumber: number): void => {
      if (cell.value == null) return;
      const key = String(cell.value).trim();
      if (!key) return;
      headerMap.set(key, colNumber);
    },
  );

  const missing: string[] = [];
  if (!headerMap.has(HEADER_NATION)) missing.push(HEADER_NATION);
  if (!headerMap.has(HEADER_NATION_ID)) missing.push(HEADER_NATION_ID);
  if (missing.length > 0) {
    throw new Error(
      `Missing required column(s): ${missing.join(
        ", ",
      )}. Make sure your header row matches the template exactly.`,
    );
  }

  const attackerCols = HEADER_ATTACKERS.map(
    (h) => headerMap.get(h) ?? null,
  );

  const nationIdCol = headerMap.get(HEADER_NATION_ID)!;
  const nationNameCol = headerMap.get(HEADER_NATION)!;

  const targets: TargetRow[] = [];
  const warnings: string[] = [];

  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
    const row = sheet.getRow(rowNumber);
    if (!row || row.cellCount === 0) continue;

    const rawNationId = row.getCell(nationIdCol).value;
    if (rawNationId == null || rawNationId === "") continue;

    const parsedNationId = parseInt(String(rawNationId).trim(), 10);
    if (!Number.isFinite(parsedNationId)) {
      warnings.push(
        `Row ${rowNumber}: invalid NationID (${String(
          rawNationId,
        )}). Skipping this row.`,
      );
      continue;
    }

    const rawNationName = row.getCell(nationNameCol).value;
    const nationName =
      rawNationName != null && rawNationName !== ""
        ? String(rawNationName).trim()
        : `Nation ${parsedNationId}`;

    const attackers: number[] = [];
    attackerCols.forEach((col, idx) => {
      if (!col) return;
      const rawAttacker = row.getCell(col).value;
      if (rawAttacker == null || rawAttacker === "") return;
      const parsed = parseInt(String(rawAttacker).trim(), 10);
      if (Number.isFinite(parsed)) {
        attackers.push(parsed);
      } else {
        warnings.push(
          `Row ${rowNumber}: invalid value in "${HEADER_ATTACKERS[idx]}" (${String(
            rawAttacker,
          )}).`,
        );
      }
    });

    targets.push({
      rowNumber,
      nationName,
      nationId: parsedNationId,
      attackers,
    });
  }

  return { targets, warnings };
}

function makeChannelName(prefix: string, target: TargetRow): string {
  const slug = target.nationName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const base = `${prefix}-${target.nationId}`;
  let name = slug ? `${base}-${slug}` : base;
  if (name.length > 90) {
    name = name.slice(0, 90);
  }
  return name;
}

function formatAttackersList(attackers: number[]): string {
  if (attackers.length === 0) return "_none yet_";
  return attackers
    .map((id, idx) => `Fighter ${idx + 1}: Nation ${id}`)
    .join("\n");
}

async function handleTemplateSubcommand(
  interaction: ChatInputCommandInteraction,
) {
  const label =
    interaction.options.getString("label", false) ?? undefined;

  const buffer = await createTemplateWorkbook(label);

  const filenameBase =
    label && label.trim().length > 0
      ? label.trim().replace(/\s+/g, "-").toLowerCase()
      : "warplan-template";
  const filename = `${filenameBase}.xlsx`;

  await interaction.reply({
    ephemeral: true,
    content:
      "Here is your blank warplan spreadsheet template. Fill it out and use `/warplan import` or `/warplan add_members` when you're ready.",
    files: [
      {
        attachment: buffer,
        name: filename,
      },
    ],
  });
}

async function handleImportSubcommand(
  interaction: ChatInputCommandInteraction,
) {
  if (!interaction.guild) {
    await interaction.reply({
      ephemeral: true,
      content: "This command can only be used in a server.",
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const attachment = interaction.options.getAttachment("file", true);
  const categoryOption = interaction.options.getChannel(
    "category",
    true,
  );
  const roomPrefix =
    interaction.options.getString("room_prefix", false) ?? "war";
  const addMembersNow =
    interaction.options.getBoolean("add_members_now", false) ?? false;

  if (!categoryOption || categoryOption.type !== ChannelType.GuildCategory) {
    await interaction.editReply({
      content:
        "The `category` option must be a category channel (where war rooms will be created).",
    });
    return;
  }

  const category = categoryOption as CategoryChannel;

  try {
    const { targets, warnings } = await parseWarplanAttachment(attachment);

    if (targets.length === 0) {
      await interaction.editReply({
        content:
          "No valid rows found in the sheet. Make sure NationID is filled in for each target.",
      });
      return;
    }

    const guild = interaction.guild;
    const createdOrUpdated: TextChannel[] = [];
    const skippedNoChannel: TargetRow[] = [];

    for (const target of targets) {
      const basePrefix = `${roomPrefix}-${target.nationId}`;

      const existing = guild.channels.cache.find(
        (ch): ch is TextChannel =>
          ch.type === ChannelType.GuildText &&
          ch.parentId === category.id &&
          ch.name.startsWith(basePrefix),
      );

      let channel: TextChannel;

      if (existing) {
        channel = existing;
      } else {
        const name = makeChannelName(roomPrefix, target);
        channel = (await guild.channels.create({
          name,
          type: ChannelType.GuildText,
          parent: category,
          reason: `Warplan import (row ${target.rowNumber}, nation ${target.nationId})`,
        })) as TextChannel;
      }

      createdOrUpdated.push(channel);

      // Basic info message on creation/import
      await channel.send({
        content: `War room initialised for **${target.nationName}** (NationID ${target.nationId}) from row ${target.rowNumber} in the warplan sheet.`,
      });

      if (addMembersNow) {
        const attackersText = formatAttackersList(target.attackers);
        await channel.send({
          content: `Assigned attackers from sheet:\n${attackersText}`,
        });
      }
    }

    let msg = `Processed **${targets.length}** targets from the sheet.\nCreated/updated **${createdOrUpdated.length}** war room channel(s) under **${category.name}**.`;

    if (!addMembersNow) {
      msg +=
        "\n\nYou chose not to add members yet. When ready, run `/warplan add_members` with the same sheet to post fighter assignments into the rooms.";
    }

    if (warnings.length > 0) {
      const trimmed = warnings.slice(0, 10);
      msg += `\n\nWarnings (first ${trimmed.length}):\n- ${trimmed.join(
        "\n- ",
      )}`;
      if (warnings.length > trimmed.length) {
        msg += `\n…and ${warnings.length - trimmed.length} more.`;
      }
    }

    await interaction.editReply({ content: msg });
  } catch (err) {
    console.error("[warplan import] error", err);
    await interaction.editReply({
      content: `Failed to import warplan sheet: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }
}

async function handleAddMembersSubcommand(
  interaction: ChatInputCommandInteraction,
) {
  if (!interaction.guild) {
    await interaction.reply({
      ephemeral: true,
      content: "This command can only be used in a server.",
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const attachment = interaction.options.getAttachment("file", true);
  const categoryOption = interaction.options.getChannel(
    "category",
    true,
  );
  const roomPrefix =
    interaction.options.getString("room_prefix", false) ?? "war";

  if (!categoryOption || categoryOption.type !== ChannelType.GuildCategory) {
    await interaction.editReply({
      content:
        "The `category` option must be a category channel that already contains your war rooms.",
    });
    return;
  }

  const category = categoryOption as CategoryChannel;

  try {
    const { targets, warnings } = await parseWarplanAttachment(attachment);

    if (targets.length === 0) {
      await interaction.editReply({
        content:
          "No valid rows found in the sheet. Make sure NationID is filled in for each target.",
      });
      return;
    }

    const guild = interaction.guild;
    let roomsUpdated = 0;
    const missingChannels: TargetRow[] = [];

    for (const target of targets) {
      const basePrefix = `${roomPrefix}-${target.nationId}`;

      const channel = guild.channels.cache.find(
        (ch): ch is TextChannel =>
          ch.type === ChannelType.GuildText &&
          ch.parentId === category.id &&
          ch.name.startsWith(basePrefix),
      );

      if (!channel) {
        missingChannels.push(target);
        continue;
      }

      const attackersText = formatAttackersList(target.attackers);

      await channel.send({
        content: `Updated attackers from warplan sheet (row ${target.rowNumber}):\n${attackersText}`,
      });

      roomsUpdated++;
    }

    let msg = `Processed **${targets.length}** targets from the sheet.\nUpdated attacker assignments in **${roomsUpdated}** war room(s) under **${category.name}**.`;

    if (missingChannels.length > 0) {
      const preview = missingChannels.slice(0, 10);
      msg +=
        `\n\nCould not find existing channels for **${missingChannels.length}** target(s) (looking for channels named \`${roomPrefix}-<NationID>-...\` in that category). Example missing rows:\n` +
        preview
          .map(
            (t) =>
              `- Row ${t.rowNumber}: ${t.nationName} (NationID ${t.nationId})`,
          )
          .join("\n");
      if (missingChannels.length > preview.length) {
        msg += `\n…and ${
          missingChannels.length - preview.length
        } more.`;
      }
    }

    if (warnings.length > 0) {
      const trimmed = warnings.slice(0, 10);
      msg += `\n\nWarnings (first ${trimmed.length}):\n- ${trimmed.join(
        "\n- ",
      )}`;
      if (warnings.length > trimmed.length) {
        msg += `\n…and ${warnings.length - trimmed.length} more.`;
      }
    }

    await interaction.editReply({ content: msg });
  } catch (err) {
    console.error("[warplan add_members] error", err);
    await interaction.editReply({
      content: `Failed to apply members from warplan sheet: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }
}

const data = new SlashCommandBuilder()
  .setName("warplan")
  .setDescription("War planning helpers using the alliance XLSX warplan sheet")
  .addSubcommand((sub) =>
    sub
      .setName("template")
      .setDescription("Download a blank warplan spreadsheet template")
      .addStringOption((opt) =>
        opt
          .setName("label")
          .setDescription("Optional sheet name / label (e.g. 'Blitz vs XYZ')")
          .setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("import")
      .setDescription(
        "Import a completed warplan sheet and create war room channels",
      )
      .addAttachmentOption((opt) =>
        opt
          .setName("file")
          .setDescription("Completed warplan .xlsx file")
          .setRequired(true),
      )
      .addChannelOption((opt) =>
        opt
          .setName("category")
          .setDescription("Category where war rooms should be created")
          .addChannelTypes(ChannelType.GuildCategory)
          .setRequired(true),
      )
      .addStringOption((opt) =>
        opt
          .setName("room_prefix")
          .setDescription(
            "Prefix for war room channels (default: 'war', rooms are named like war-<NationID>-...)",
          )
          .setRequired(false),
      )
      .addBooleanOption((opt) =>
        opt
          .setName("add_members_now")
          .setDescription(
            "Also post attacker assignments into the rooms immediately (default: false)",
          )
          .setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("add_members")
      .setDescription(
        "Use a warplan sheet to post attacker assignments into existing war rooms",
      )
      .addAttachmentOption((opt) =>
        opt
          .setName("file")
          .setDescription("Warplan .xlsx file (same layout as template)")
          .setRequired(true),
      )
      .addChannelOption((opt) =>
        opt
          .setName("category")
          .setDescription(
            "Category that already contains the war room channels",
          )
          .addChannelTypes(ChannelType.GuildCategory)
          .setRequired(true),
      )
      .addStringOption((opt) =>
        opt
          .setName("room_prefix")
          .setDescription(
            "Prefix for war room channels (must match what you used for import, default: 'war')",
          )
          .setRequired(false),
      ),
  );

export const command = {
  data,
  async execute(interaction: ChatInputCommandInteraction) {
    const sub = interaction.options.getSubcommand();

    if (sub === "template") {
      return handleTemplateSubcommand(interaction);
    }

    if (sub === "import") {
      return handleImportSubcommand(interaction);
    }

    if (sub === "add_members") {
      return handleAddMembersSubcommand(interaction);
    }

    await interaction.reply({
      ephemeral: true,
      content: "Unknown subcommand.",
    });
  },
};

export default command;
