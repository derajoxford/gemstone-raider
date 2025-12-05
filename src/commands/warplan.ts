// src/commands/warplan.ts

import {
  AttachmentBuilder,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import * as XLSX from "xlsx";

type Command = import("../types/command.js").Command;

// ---------- PNW API helpers ----------

function getPnwGraphqlBase(): string {
  return (
    process.env.PNW_API_BASE_GRAPHQL ||
    "https://api.politicsandwar.com/graphql"
  ).trim();
}

function getPnwApiKey(): string | null {
  const raw =
    (
      process.env.PNW_API_KEY ||
      process.env.PNW_DEFAULT_API_KEY ||
      process.env.PNW_SERVICE_API_KEY ||
      ""
    ).trim() || "";
  return raw || null;
}

function flattenMaybeConnection(node: any): any[] {
  if (!node) return [];
  if (Array.isArray(node)) return node;
  if (Array.isArray(node.data)) return node.data;
  return [];
}

type NationStats = {
  id: number;
  name: string;
  allianceName?: string;
  alliancePosition?: string;
  warPolicy?: string;
  color?: string;
  score?: number;
  cities?: number;
  soldiers?: number;
  tanks?: number;
  aircraft?: number;
  ships?: number;
  missiles?: number;
  nukes?: number;
  spies?: number;
  beigeTurns?: number;
  offensiveWars?: number;
  defensiveWars?: number;
};

async function fetchNationStats(nationId: number): Promise<NationStats | null> {
  const key = getPnwApiKey();
  if (!key) {
    console.error(
      "[WARPLAN] fetchNationStats: missing PNW API key (PNW_API_KEY / PNW_DEFAULT_API_KEY / PNW_SERVICE_API_KEY)",
    );
    return null;
  }

  const base = getPnwGraphqlBase();
  const url = `${base}?api_key=${encodeURIComponent(key)}`;

  // No variables on purpose – mirrors your working curl example.
  const query = `
    {
      nations(id: ${nationId}, first: 1) {
        data {
          id
          nation_name
          score
          num_cities
          soldiers
          tanks
          aircraft
          ships
          missiles
          nukes
          spies
          beige_turns_left
          color
          war_policy
          alliance_id
          alliance_position
          alliance { name }
          offensive_wars { id }
          defensive_wars { id }
        }
      }
    }
  `;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });

    if (!res.ok) {
      console.error(
        "[WARPLAN] fetchNationStats: HTTP",
        res.status,
        await res.text().catch(() => ""),
      );
      return null;
    }

    const json: any = await res.json();

    if (json.errors?.length) {
      console.error("[WARPLAN] fetchNationStats: GraphQL errors", json.errors);
    }

    let block = json.data?.nations;
    let rows: any[] = [];
    if (Array.isArray(block)) {
      rows = block;
    } else if (block && Array.isArray(block.data)) {
      rows = block.data;
    }

    const row = rows[0];
    if (!row) return null;

    const num = (v: any): number | undefined => {
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };

    const offArr = flattenMaybeConnection(row.offensive_wars);
    const defArr = flattenMaybeConnection(row.defensive_wars);

    const stats: NationStats = {
      id: num(row.id) ?? nationId,
      name:
        typeof row.nation_name === "string" && row.nation_name.trim().length
          ? row.nation_name.trim()
          : `Nation ${nationId}`,
      allianceName:
        typeof row.alliance?.name === "string" &&
        row.alliance.name.trim().length
          ? row.alliance.name.trim()
          : undefined,
      alliancePosition:
        typeof row.alliance_position === "string"
          ? row.alliance_position
          : undefined,
      warPolicy:
        typeof row.war_policy === "string" ? row.war_policy : undefined,
      color: typeof row.color === "string" ? row.color : undefined,
      score: num(row.score),
      cities: num(row.num_cities ?? row.cities),
      soldiers: num(row.soldiers),
      tanks: num(row.tanks),
      aircraft: num(row.aircraft),
      ships: num(row.ships),
      missiles: num(row.missiles),
      nukes: num(row.nukes),
      spies: num(row.spies),
      beigeTurns: num(row.beige_turns_left ?? row.beige_turns),
      offensiveWars: offArr.length || undefined,
      defensiveWars: defArr.length || undefined,
    };

    return stats;
  } catch (err) {
    console.error("[WARPLAN] fetchNationStats: error", err);
    return null;
  }
}

async function fetchAllianceMemberNationIds(
  allianceIds: number[],
): Promise<number[]> {
  const key = getPnwApiKey();
  if (!key) {
    console.error(
      "[WARPLAN] fetchAllianceMemberNationIds: missing PNW API key",
    );
    return [];
  }

  const base = getPnwGraphqlBase();
  const url = `${base}?api_key=${encodeURIComponent(key)}`;

  const uniq = Array.from(
    new Set(
      allianceIds.filter((n) => Number.isFinite(n) && n > 0),
    ),
  );

  const out = new Set<number>();

  for (const aid of uniq) {
    const query = `
      {
        nations(alliance_id: [${aid}], first: 500) {
          data {
            id
          }
        }
      }
    `;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });

      if (!res.ok) {
        console.error(
          "[WARPLAN] fetchAllianceMemberNationIds: HTTP",
          res.status,
          await res.text().catch(() => ""),
        );
        continue;
      }

      const json: any = await res.json();
      if (json.errors?.length) {
        console.error(
          `[WARPLAN] fetchAllianceMemberNationIds: GQL errors for alliance ${aid}`,
          json.errors,
        );
      }

      const block = json.data?.nations;
      let list: any[] = [];
      if (Array.isArray(block)) list = block;
      else if (block && Array.isArray(block.data)) list = block.data;

      for (const row of list) {
        const idNum = Number(row.id);
        if (Number.isFinite(idNum) && idNum > 0) out.add(idNum);
      }
    } catch (err) {
      console.error(
        `[WARPLAN] fetchAllianceMemberNationIds: error for alliance ${aid}`,
        err,
      );
    }
  }

  return Array.from(out).sort((a, b) => a - b);
}

// ---------- Blitz sheet helpers ----------

const BLITZ_HEADERS = [
  "Nation",
  "Nation ID",
  "Alliance",
  "Alliance Position",
  "War Policy",
  "Color",
  "Score",
  "Cities",
  "Soldiers",
  "Tanks",
  "Aircraft",
  "Ships",
  "Missiles",
  "Nukes",
  "Spies",
  "Beige Turns",
  "Offensive Wars",
  "Defensive Wars",
  "Target Notes",
  "Attacker 1",
  "Attacker 2",
  "Attacker 3",
] as const;

const COL_NATION = 0;
const COL_NATION_ID = 1;
const COL_ALLIANCE = 2;
const COL_ALLIANCE_POSITION = 3;
const COL_WAR_POLICY = 4;
const COL_COLOR = 5;
const COL_SCORE = 6;
const COL_CITIES = 7;
const COL_SOLDIERS = 8;
const COL_TANKS = 9;
const COL_AIRCRAFT = 10;
const COL_SHIPS = 11;
const COL_MISSILES = 12;
const COL_NUKES = 13;
const COL_SPIES = 14;
const COL_BEIGE_TURNS = 15;
const COL_OFF_WARS = 16;
const COL_DEF_WARS = 17;
const COL_TARGET_NOTES = 18;
const COL_ATTACKER_1 = 19;
const COL_ATTACKER_2 = 20;
const COL_ATTACKER_3 = 21;

type BlitzRow = {
  nationId: number;
  nationName: string;
  allianceName?: string;
  alliancePosition?: string;
  warPolicy?: string;
  color?: string;
  score?: number;
  cities?: number;
  soldiers?: number;
  tanks?: number;
  aircraft?: number;
  ships?: number;
  missiles?: number;
  nukes?: number;
  spies?: number;
  beigeTurns?: number;
  offensiveWars?: number;
  defensiveWars?: number;
  notes?: string | null;
  attackers: number[];
};

function normalizeHeaderCell(v: unknown): string {
  return String(v ?? "").trim();
}

function validateHeaderRow(headerRow: any[]): string | null {
  for (let i = 0; i < BLITZ_HEADERS.length; i++) {
    const expected = BLITZ_HEADERS[i];
    const actual = normalizeHeaderCell(headerRow[i]);
    if (expected !== actual) {
      return `Col ${i + 1}: expected **${expected}** but found **${
        actual || "(blank)"
      }**`;
    }
  }
  return null;
}

function parseBlitzSheet(wb: XLSX.WorkBook): BlitzRow[] {
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1 }) as any[][];

  if (!rows.length) throw new Error("Sheet is empty.");

  const header = rows[0] ?? [];
  const headerError = validateHeaderRow(header);
  if (headerError) {
    throw new Error(
      "The first row doesn’t match the expected Blitz header format.\n\n" +
        headerError,
    );
  }

  const out: BlitzRow[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (
      !row ||
      row.every(
        (c) =>
          c === null ||
          c === undefined ||
          String(c).trim().length === 0,
      )
    ) {
      continue;
    }

    const rawId = row[COL_NATION_ID];
    const nationId = Number(rawId);
    if (!Number.isFinite(nationId) || nationId <= 0) continue;

    const asStr = (idx: number): string => {
      const v = row[idx];
      return v === undefined || v === null ? "" : String(v);
    };
    const asNum = (idx: number): number | undefined => {
      const v = row[idx];
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };

    const attackers: number[] = [];
    for (const col of [COL_ATTACKER_1, COL_ATTACKER_2, COL_ATTACKER_3]) {
      const val = row[col];
      if (val === undefined || val === null) continue;
      const n = Number(val);
      if (Number.isFinite(n) && n > 0) attackers.push(n);
    }

    out.push({
      nationId,
      nationName: asStr(COL_NATION).trim(),
      allianceName: asStr(COL_ALLIANCE).trim() || undefined,
      alliancePosition:
        asStr(COL_ALLIANCE_POSITION).trim() || undefined,
      warPolicy: asStr(COL_WAR_POLICY).trim() || undefined,
      color: asStr(COL_COLOR).trim() || undefined,
      score: asNum(COL_SCORE),
      cities: asNum(COL_CITIES),
      soldiers: asNum(COL_SOLDIERS),
      tanks: asNum(COL_TANKS),
      aircraft: asNum(COL_AIRCRAFT),
      ships: asNum(COL_SHIPS),
      missiles: asNum(COL_MISSILES),
      nukes: asNum(COL_NUKES),
      spies: asNum(COL_SPIES),
      beigeTurns: asNum(COL_BEIGE_TURNS),
      offensiveWars: asNum(COL_OFF_WARS),
      defensiveWars: asNum(COL_DEF_WARS),
      notes: asStr(COL_TARGET_NOTES).trim() || null,
      attackers,
    });
  }

  return out;
}

function buildWorkbookFromRows(rows: BlitzRow[]): XLSX.WorkBook {
  const data: any[][] = [];

  data.push([...BLITZ_HEADERS]);

  for (const row of rows) {
    data.push([
      row.nationName || "",
      row.nationId || "",
      row.allianceName || "",
      row.alliancePosition || "",
      row.warPolicy || "",
      row.color || "",
      row.score ?? "",
      row.cities ?? "",
      row.soldiers ?? "",
      row.tanks ?? "",
      row.aircraft ?? "",
      row.ships ?? "",
      row.missiles ?? "",
      row.nukes ?? "",
      row.spies ?? "",
      row.beigeTurns ?? "",
      row.offensiveWars ?? "",
      row.defensiveWars ?? "",
      row.notes ?? "",
      row.attackers[0] ?? "",
      row.attackers[1] ?? "",
      row.attackers[2] ?? "",
    ]);
  }

  const ws = XLSX.utils.aoa_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Blitz");
  return wb;
}

function parseIdList(raw: string): number[] {
  return Array.from(
    new Set(
      raw
        .split(/[^0-9]+/g)
        .map((s) => Number(s))
        .filter((n) => Number.isFinite(n) && n > 0),
    ),
  );
}

// ---------- subcommand handlers ----------

async function handleSeedNations(
  interaction: ChatInputCommandInteraction,
) {
  const raw = interaction.options.getString("nation_ids", true);
  const ids = parseIdList(raw);

  if (!ids.length) {
    await interaction.reply({
      content:
        "I couldn’t see any valid nation IDs in that string. Paste nation IDs (or URLs) separated by spaces/commas.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const rows: BlitzRow[] = [];

  for (const id of ids) {
    const stats = await fetchNationStats(id);
    if (!stats) continue;

    rows.push({
      nationId: stats.id,
      nationName: stats.name,
      allianceName: stats.allianceName,
      alliancePosition: stats.alliancePosition,
      warPolicy: stats.warPolicy,
      color: stats.color,
      score: stats.score,
      cities: stats.cities,
      soldiers: stats.soldiers,
      tanks: stats.tanks,
      aircraft: stats.aircraft,
      ships: stats.ships,
      missiles: stats.missiles,
      nukes: stats.nukes,
      spies: stats.spies,
      beigeTurns: stats.beigeTurns,
      offensiveWars: stats.offensiveWars,
      defensiveWars: stats.defensiveWars,
      notes: null,
      attackers: [],
    });
  }

  if (!rows.length) {
    await interaction.editReply({
      content:
        "I couldn’t fetch any nation data for those IDs. Double-check they’re valid PnW Nation IDs.",
    });
    return;
  }

  const wb = buildWorkbookFromRows(rows);
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  const attach = new AttachmentBuilder(Buffer.from(buf)).setName(
    "warplan_seed_nations.xlsx",
  );

  await interaction.editReply({
    content:
      `✅ Seeded **${rows.length}** targets from nation IDs.\n\n` +
      "1. Open the sheet.\n" +
      "2. Fill **Attacker 1–3** with attacker nation IDs.\n" +
      "3. Save and use `/warplan import` to re-enrich after edits (and then `/warroom` to spin channels).",
    files: [attach],
  });
}

async function handleSeedAlliance(
  interaction: ChatInputCommandInteraction,
) {
  const raw = interaction.options.getString("alliance_ids", true);
  const aids = parseIdList(raw);

  if (!aids.length) {
    await interaction.reply({
      content:
        "I couldn’t see any valid alliance IDs. Paste alliance IDs separated by spaces/commas.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const nationIds = await fetchAllianceMemberNationIds(aids);
  if (!nationIds.length) {
    await interaction.editReply({
      content:
        "I couldn’t find any nations for those alliance IDs.",
    });
    return;
  }

  const rows: BlitzRow[] = [];
  for (const nid of nationIds) {
    const stats = await fetchNationStats(nid);
    if (!stats) continue;

    rows.push({
      nationId: stats.id,
      nationName: stats.name,
      allianceName: stats.allianceName,
      alliancePosition: stats.alliancePosition,
      warPolicy: stats.warPolicy,
      color: stats.color,
      score: stats.score,
      cities: stats.cities,
      soldiers: stats.soldiers,
      tanks: stats.tanks,
      aircraft: stats.aircraft,
      ships: stats.ships,
      missiles: stats.missiles,
      nukes: stats.nukes,
      spies: stats.spies,
      beigeTurns: stats.beigeTurns,
      offensiveWars: stats.offensiveWars,
      defensiveWars: stats.defensiveWars,
      notes: null,
      attackers: [],
    });
  }

  if (!rows.length) {
    await interaction.editReply({
      content:
        "I found nations for those alliances, but couldn’t fetch stats for any of them. That usually means the API key is throttled or something’s off upstream.",
    });
    return;
  }

  const wb = buildWorkbookFromRows(rows);
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  const attach = new AttachmentBuilder(Buffer.from(buf)).setName(
    "warplan_seed_alliance.xlsx",
  );

  await interaction.editReply({
    content:
      `✅ Seeded **${rows.length}** targets from alliance IDs (${aids.join(
        ", ",
      )}).\n\n` +
      "1. Open the sheet.\n" +
      "2. Assign **Attacker 1–3**.\n" +
      "3. Save and use `/warplan import` or `/warroom` as needed.",
    files: [attach],
  });
}

async function handleImport(interaction: ChatInputCommandInteraction) {
  const file = interaction.options.getAttachment("file", true);
  const autoEnrich =
    interaction.options.getBoolean("auto_enrich") ?? true;
  const createWarrooms =
    interaction.options.getBoolean("create_warrooms") ?? false;

  if (!interaction.guild) {
    await interaction.reply({
      content: "This only works in a guild.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  let buffer: ArrayBuffer;
  try {
    const res = await fetch(file.url);
    if (!res.ok) {
      await interaction.editReply({
        content: `I couldn’t download that file (HTTP ${res.status}).`,
      });
      return;
    }
    buffer = await res.arrayBuffer();
  } catch (err: any) {
    await interaction.editReply({
      content: `I couldn’t download that file:\n\`${String(err?.message ?? err)}\``,
    });
    return;
  }

  let rows: BlitzRow[];
  try {
    const wb = XLSX.read(Buffer.from(buffer), { type: "buffer" });
    rows = parseBlitzSheet(wb);
  } catch (err: any) {
    await interaction.editReply({
      content: `❌ I couldn’t read that sheet:\n\`${String(err?.message ?? err)}\``,
    });
    return;
  }

  if (!rows.length) {
    await interaction.editReply({
      content:
        "The sheet parsed correctly but there were no usable target rows.",
    });
    return;
  }

  if (autoEnrich) {
    for (const row of rows) {
      const stats = await fetchNationStats(row.nationId);
      if (!stats) continue;

      row.nationName = stats.name;
      row.allianceName = stats.allianceName;
      row.alliancePosition = stats.alliancePosition;
      row.warPolicy = stats.warPolicy;
      row.color = stats.color;
      row.score = stats.score;
      row.cities = stats.cities;
      row.soldiers = stats.soldiers;
      row.tanks = stats.tanks;
      row.aircraft = stats.aircraft;
      row.ships = stats.ships;
      row.missiles = stats.missiles;
      row.nukes = stats.nukes;
      row.spies = stats.spies;
      row.beigeTurns = stats.beigeTurns;
      row.offensiveWars = stats.offensiveWars;
      row.defensiveWars = stats.defensiveWars;
    }
  }

  const wbOut = buildWorkbookFromRows(rows);
  const outBuf = XLSX.write(wbOut, { type: "buffer", bookType: "xlsx" });
  const attach = new AttachmentBuilder(Buffer.from(outBuf)).setName(
    "warplan_enriched.xlsx",
  );

  let extraNote = "";
  if (createWarrooms) {
    // Being explicit so you’re not surprised.
    extraNote =
      "\n\n⚠️ `create_warrooms` is currently **ignored** in this build – " +
      "this command only handles the spreadsheet. Use `/warroom` to create actual channels.";
  }

  await interaction.editReply({
    content:
      `✅ Processed **${rows.length}** targets from the uploaded sheet.` +
      "\n\nYou can now:\n" +
      "• Use this enriched sheet for coordination, or\n" +
      "• Edit attackers and re-run `/warplan import` for another refresh.\n" +
      extraNote,
    files: [attach],
  });
}

// ---------- command export ----------

const command: Command = {
  data: new SlashCommandBuilder()
    .setName("warplan")
    .setDescription("Generate/import blitz war planning sheets")
    .addSubcommand((sub) =>
      sub
        .setName("seed_nations")
        .setDescription(
          "Seed a warplan sheet from a list of enemy nation IDs",
        )
        .addStringOption((opt) =>
          opt
            .setName("nation_ids")
            .setDescription(
              "Nation IDs or URLs (comma/space separated)",
            )
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("seed_alliance")
        .setDescription(
          "Seed a warplan sheet from one or more alliance IDs",
        )
        .addStringOption((opt) =>
          opt
            .setName("alliance_ids")
            .setDescription(
              "Alliance IDs (comma/space separated, supports multiple)",
            )
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("import")
        .setDescription(
          "Import a warplan sheet and optionally enrich it with live PnW data",
        )
        .addAttachmentOption((opt) =>
          opt
            .setName("file")
            .setDescription("XLSX warplan sheet to import")
            .setRequired(true),
        )
        .addBooleanOption((opt) =>
          opt
            .setName("auto_enrich")
            .setDescription(
              "Refresh PnW stats for each target (default: true)",
            ),
        )
        .addBooleanOption((opt) =>
          opt
            .setName("create_warrooms")
            .setDescription(
              "Placeholder flag – currently ignored; use /warroom for channels",
            ),
        ),
    ),
  async execute(interaction) {
    const sub = interaction.options.getSubcommand(true);
    if (sub === "seed_nations") return handleSeedNations(interaction);
    if (sub === "seed_alliance") return handleSeedAlliance(interaction);
    if (sub === "import") return handleImport(interaction);

    await interaction.reply({
      content: "Unknown subcommand.",
      ephemeral: true,
    });
  },
};

export default command;

