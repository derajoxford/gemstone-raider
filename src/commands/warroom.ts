// src/commands/warroom.ts
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  Colors,
  EmbedBuilder,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  User,
} from "discord.js";
import { query } from "../data/db.js";
import { fetchActiveWars, type WarRecord } from "../pnw/wars.js";

type Command = import("../types/command.js").Command;

type WarRoomRow = {
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
};

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

// ---------- helpers ----------
function parseNationTarget(raw: string): { id: number; url: string } | null {
  raw = raw.trim();
  const urlMatch = raw.match(/nation\/id=(\d+)/i);
  if (urlMatch) {
    const id = Number(urlMatch[1]);
    if (id > 0) return { id, url: `https://politicsandwar.com/nation/id=${id}` };
  }
  const id = Number(raw);
  if (Number.isFinite(id) && id > 0)
    return { id, url: `https://politicsandwar.com/nation/id=${id}` };
  return null;
}
function nationLink(id: number, name?: string | null) {
  const safe = name && name.trim().length ? name.trim() : `Nation #${id}`;
  return `[${safe}](https://politicsandwar.com/nation/id=${id})`;
}
async function fetchNationNameViaGraphQL(nationId: number): Promise<string | null> {
  const base =
    (process.env.PNW_API_BASE_GRAPHQL ||
      "https://api.politicsandwar.com/graphql").trim();
  const key =
    (process.env.PNW_API_KEY ||
      process.env.PNW_DEFAULT_API_KEY ||
      process.env.PNW_SERVICE_API_KEY ||
      "").trim();
  if (!key) return null;

  try {
    const res = await fetch(`${base}?api_key=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `{ nations(id:${nationId}){ data { nation_name } } }`,
      }),
    });
    if (!res.ok) return null;
    const j: any = await res.json();
    return j.data?.nations?.data?.[0]?.nation_name ?? null;
  } catch {
    return null;
  }
}
async function fetchNationDossier(nationId: number): Promise<DossierInfo | null> {
  const base =
    (process.env.PNW_API_BASE_REST || "https://politicsandwar.com/api").trim();
  const key =
    (process.env.PNW_API_KEY ||
      process.env.PNW_DEFAULT_API_KEY ||
      process.env.PNW_SERVICE_API_KEY ||
      "").trim();
  if (!key) return null;
  const url = `${base.replace(/\/+$/, "")}/nation/id=${nationId}/&key=${encodeURIComponent(
    key,
  )}`;
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
        typeof d.alliance === "string" && d.alliance !== "0" ? d.alliance : undefined,
    };
  } catch {
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

// ---------- wars block (W1 minimal + slots) ----------
function formatWarsBlock(offense: WarRecord[], defense: WarRecord[]): string {
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

  return [slotLine, "", `🗡️ **Offense**`, oBlock, "", `🛡️ **Defense**`, dBlock].join(
    "\n",
  );
}

// ---------- dossier block ----------
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

// ---------- embed ----------
function buildControlEmbed(
  row: WarRoomRow,
  creator: User,
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
        `🎯 **Target:** ${nationLink(row.target_nation_id, row.target_nation_name)}`,
        `👤 **Created by:** <@${row.created_by_id}>`,
        `⚔️ **Wars:** O ${offense.length} • D ${defense.length}`,
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

// ---------- DB ----------
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
async function getWarRoomByChannel(
  guildId: string,
  channelId: string,
): Promise<WarRoomRow | null> {
  const { rows } = await query<WarRoomRow>(
    `SELECT * FROM war_rooms WHERE guild_id=$1 AND channel_id=$2 LIMIT 1`,
    [guildId, channelId],
  );
  return rows[0] ?? null;
}
async function getWarRoomById(id: string): Promise<WarRoomRow | null> {
  const { rows } = await query<WarRoomRow>(
    `SELECT * FROM war_rooms WHERE id=$1 LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}
async function updateWarRoomMembers(id: string, memberIds: string[]) {
  await query(`UPDATE war_rooms SET member_ids=$2 WHERE id=$1`, [id, memberIds]);
}
async function updateWarRoomControlMessage(id: string, msgId: string | null) {
  await query(`UPDATE war_rooms SET control_message_id=$2 WHERE id=$1`, [
    id,
    msgId,
  ]);
}
async function updateWarRoomNotes(id: string, notes: string | null) {
  await query(`UPDATE war_rooms SET notes=$2 WHERE id=$1`, [id, notes]);
}

// ---------- command flow ----------
async function handleSetup(interaction: ChatInputCommandInteraction) {
  const guild = interaction.guild;
  if (!guild)
    return interaction.reply({ content: "Not in a guild.", ephemeral: true });

  const targetRaw = interaction.options.getString("target", true);
  const member1 = interaction.options.getUser("member1");
  const member2 = interaction.options.getUser("member2");
  const member3 = interaction.options.getUser("member3");

  const parsed = parseNationTarget(targetRaw);
  if (!parsed)
    return interaction.reply({
      content:
        "Could not parse target. Use a nation ID or URL like `https://politicsandwar.com/nation/id=12345`.",
      ephemeral: true,
    });

  const modal = new ModalBuilder().setTitle("Create War Room");

  const targetInput = new TextInputBuilder()
    .setCustomId("target")
    .setLabel("Target Nation (ID or URL)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setValue(targetRaw);

  const notesInput = new TextInputBuilder()
    .setCustomId("notes")
    .setLabel("Notes (visible in war room)")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(1000);

  const members = [
    interaction.user.id,
    ...(member1 ? [member1.id] : []),
    ...(member2 ? [member2.id] : []),
    ...(member3 ? [member3.id] : []),
  ].filter((v, i, a) => a.indexOf(v) === i);

  modal.setCustomId(`warroom:setup:${parsed.id}:${members.join(",")}`);
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(targetInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(notesInput),
  );

  await interaction.showModal(modal);
}

async function handleSetupModal(interaction: any) {
  if (!interaction.isModalSubmit()) return;

  const { guild, user } = interaction;
  if (!guild)
    return interaction.reply({ content: "Guild missing.", ephemeral: true });

  const [prefix, kind, nidStr, membersStr] = interaction.customId.split(":");
  if (prefix !== "warroom" || kind !== "setup") return;

  const nationId = Number(nidStr);
  if (!Number.isFinite(nationId) || nationId <= 0)
    return interaction.reply({
      content: "Invalid nation ID in modal.",
      ephemeral: true,
    });

  const targetField = interaction.fields.getTextInputValue("target") || "";
  const notesField = interaction.fields.getTextInputValue("notes") || "";

  const parsed = parseNationTarget(targetField);
  if (!parsed)
    return interaction.reply({
      content: "Could not parse target nation from modal.",
      ephemeral: true,
    });

  const memberIds = (membersStr || "")
    .split(",")
    .map((s: string) => s.trim())
    .filter(Boolean);

  await interaction.deferReply({ ephemeral: true });

  const targetName =
    (await fetchNationNameViaGraphQL(parsed.id)) || `Nation #${parsed.id}`;

  const slug = targetName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const channelName = `war-${slug || parsed.id}`;
  const categoryName = process.env.WARROOM_CATEGORY_NAME || "WAR ROOMS";

  let warCat =
    guild.channels.cache.find(
      (c: any) => c.type === 4 && c.name.toLowerCase() === categoryName.toLowerCase(),
    ) || null;

  if (!warCat) {
    warCat = await guild.channels.create({
      name: categoryName,
      type: 4,
      reason: "Gemstone Raider — War Rooms category",
    } as any);
  }

  const channel = await guild.channels.create({
    name: channelName,
    parent: warCat.id,
    topic: `War room for ${targetName} (#${parsed.id})`,
    reason: `War room created by ${user.tag}`,
  } as any);

  const uniqueIds = Array.from(new Set([user.id, ...memberIds]));
  for (const mid of uniqueIds) {
    await channel.permissionOverwrites
      .edit(mid, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
      })
      .catch(() => {});
  }

  const dossier = await fetchNationDossier(parsed.id);
  const { offense, defense } = await fetchActiveWars(parsed.id);

  const row: WarRoomRow = {
    id: "0",
    guild_id: guild.id,
    channel_id: channel.id,
    control_message_id: null,
    name: targetName,
    created_by_id: user.id,
    target_nation_id: parsed.id,
    target_nation_name: targetName,
    notes: notesField.trim() || null,
    member_ids: uniqueIds,
    created_at: new Date(),
  };

  const embed = buildControlEmbed(row, user, dossier, offense, defense);
  const controlMsg = await channel.send({
    content: uniqueIds.map((id) => `<@${id}>`).join(" "),
    embeds: [embed],
    components: [buildControlRow()],
  });

  await controlMsg.pin().catch(() => {});
  await insertWarRoom({
    guildId: row.guild_id,
    channelId: row.channel_id,
    controlMessageId: controlMsg.id,
    name: row.name,
    createdById: row.created_by_id,
    targetNationId: row.target_nation_id,
    targetNationName: row.target_nation_name,
    notes: row.notes,
    memberIds: row.member_ids,
  });

  await interaction.editReply({ content: `✅ War room created: <#${channel.id}>` });
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

async function requireRoomFromButton(
  interaction: ButtonInteraction,
): Promise<WarRoomRow | null> {
  const gid = interaction.guildId;
  const cid = interaction.channelId;
  if (!gid || !cid) {
    await interaction.reply({ content: "Not in a war room.", ephemeral: true });
    return null;
  }
  const row = await getWarRoomByChannel(gid, cid);
  if (!row) {
    await interaction.reply({ content: "No war room record.", ephemeral: true });
    return null;
  }
  return row;
}

async function handleAddMember(interaction: ButtonInteraction) {
  const row = await requireRoomFromButton(interaction);
  if (!row) return true;

  const modal = new ModalBuilder()
    .setCustomId(`warroom:addMember:${row.id}`)
    .setTitle("Add Member to War Room");

  const input = new TextInputBuilder()
    .setCustomId("user")
    .setLabel("User ID or @mention")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(input),
  );

  await interaction.showModal(modal);
  return true;
}

async function handleRemoveMember(interaction: ButtonInteraction) {
  const row = await requireRoomFromButton(interaction);
  if (!row) return true;

  const modal = new ModalBuilder()
    .setCustomId(`warroom:removeMember:${row.id}`)
    .setTitle("Remove Member from War Room");

  const input = new TextInputBuilder()
    .setCustomId("user")
    .setLabel("User ID or @mention")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(input),
  );

  await interaction.showModal(modal);
  return true;
}

async function handleEditNotes(interaction: ButtonInteraction) {
  const row = await requireRoomFromButton(interaction);
  if (!row) return true;

  const modal = new ModalBuilder()
    .setCustomId(`warroom:editNotes:${row.id}`)
    .setTitle("Edit War Room Notes");
