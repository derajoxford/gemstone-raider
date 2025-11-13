// src/commands/warroom.ts
// FULL WAR ROOM COMMAND — with ACTIVE WARS via GraphQL, W1 formatting

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
  SlashCommandSubcommandsOnlyBuilder,
  TextInputBuilder,
  TextInputStyle,
  User,
} from "discord.js";

import { query } from "../data/db.js";
import { fetchActiveWars, type WarRecord } from "../pnw/wars.js";

// ------------------------------------------------------
// Types
// ------------------------------------------------------

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

// ------------------------------------------------------
// Target parsing
// ------------------------------------------------------

function parseNationTarget(raw: string): { id: number; url: string } | null {
  raw = raw.trim();
  const urlMatch = raw.match(/nation\/id=(\d+)/i);
  if (urlMatch) {
    const id = Number(urlMatch[1]);
    if (id > 0)
      return {
        id,
        url: `https://politicsandwar.com/nation/id=${id}`,
      };
  }
  const id = Number(raw);
  if (Number.isFinite(id) && id > 0)
    return {
      id,
      url: `https://politicsandwar.com/nation/id=${id}`,
    };
  return null;
}

function nationLink(id: number, name: string | null): string {
  const safe = name && name.trim().length > 0 ? name.trim() : `Nation #${id}`;
  return `[${safe}](https://politicsandwar.com/nation/id=${id})`;
}

// ------------------------------------------------------
// Nation lookups + dossier
// ------------------------------------------------------

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

  const body = {
    query: `{ nations(id:${nationId}){ data { nation_name } } }`,
  };

  try {
    const res = await fetch(`${base}?api_key=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;

    const json: any = await res.json();
    const name = json.data?.nations?.data?.[0]?.nation_name;
    return name ?? null;
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
    const data: any = await res.json();
    if (data.success === false) return null;

    const x = (v: any) =>
      v !== undefined && Number.isFinite(Number(v)) ? Number(v) : undefined;

    return {
      score: x(data.score),
      cities: x(data.cities),
      soldiers: x(data.soldiers),
      tanks: x(data.tanks),
      aircraft: x(data.aircraft),
      ships: x(data.ships),
      missiles: x(data.missiles),
      nukes: x(data.nukes),
      beigeTurns: x(data.beige_turns_left),
      allianceName:
        typeof data.alliance === "string" && data.alliance !== "0"
          ? data.alliance
          : undefined,
    };
  } catch {
    return null;
  }
}

// ------------------------------------------------------
// Wars Block (W1 FORMAT — ACTIVE ONLY)
// ------------------------------------------------------

function formatWarsBlock(
  offense: WarRecord[],
  defense: WarRecord[],
  targetId: number,
): string {
  const fmt = (w: WarRecord) => {
    const att = w.attacker?.nation_name || `#${w.attacker_id}`;
    const def = w.defender?.nation_name || `#${w.defender_id}`;

    return [
      `• **${att}** → **${def}**`,
      `   [Open War](https://politicsandwar.com/nation/war/status/war=${w.id}) • [Open Nation](https://politicsandwar.com/nation/id=${w.defender_id}) • [Declare](https://politicsandwar.com/nation/war/declare/id=${w.defender_id})`,
      `   Turns Left: ${w.turns_left ?? "?""}${w.reason ? ` • “${w.reason}”` : ""}`,
    ].join("\n");
  };

  const oBlock =
    offense.length > 0
      ? offense.map((w) => fmt(w)).join("\n\n")
      : "*None*";

  const dBlock =
    defense.length > 0
      ? defense.map((w) => fmt(w)).join("\n\n")
      : "*None*";

  return [
    `🗡️ **Offense**`,
    oBlock,
    "",
    `🛡️ **Defense**`,
    dBlock,
  ].join("\n");
}

// ------------------------------------------------------
// Dossier block
// ------------------------------------------------------

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

// ------------------------------------------------------
// Embed builder
// ------------------------------------------------------

function buildControlEmbed(
  row: WarRoomRow,
  creator: User,
  dossier: DossierInfo | null,
  offense: WarRecord[],
  defense: WarRecord[],
): EmbedBuilder {
  const warsBlock = formatWarsBlock(offense, defense, row.target_nation_id);

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
        "",
        "⚔️ **Active Wars** (Offense + Defense)",
        warsBlock,
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

// ------------------------------------------------------
// DB helpers
// ------------------------------------------------------

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

async function updateWarRoomMembers(id: string, memberIds: string[]): Promise<void> {
  await query(`UPDATE war_rooms SET member_ids=$2 WHERE id=$1`, [id, memberIds]);
}

async function updateWarRoomControlMessage(
  id: string,
  msgId: string | null,
): Promise<void> {
  await query(`UPDATE war_rooms SET control_message_id=$2 WHERE id=$1`, [
    id,
    msgId,
  ]);
}

// ------------------------------------------------------
// /warroom setup
// ------------------------------------------------------

async function handleSetup(interaction: ChatInputCommandInteraction) {
  const guild = interaction.guild;
  if (!guild)
    return interaction.reply({
      content: "Not in a guild.",
      ephemeral: true,
    });

  const targetRaw = interaction.options.getString("target", true);
  const member1 = interaction.options.getUser("member1");
  const member2 = interaction.options.getUser("member2");
  const member3 = interaction.options.getUser("member3");

  const parsed = parseNationTarget(targetRaw);
  if (!parsed)
    return interaction.reply({
      content: "Invalid nation target.",
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
    .setLabel("Notes (optional)")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false);

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

// ------------------------------------------------------
// Setup Modal -> Create channel
// ------------------------------------------------------

async function handleSetupModal(interaction: any) {
  if (!interaction.isModalSubmit()) return;

  const { guild, user } = interaction;
  if (!guild)
    return interaction.reply({
      content: "Guild missing.",
      ephemeral: true,
    });

  const [prefix, cmd, idStr, membersStr] = interaction.customId.split(":");
  if (prefix !== "warroom" || cmd !== "setup") return;

  const nationId = Number(idStr);
  const memberIds = membersStr
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

  const rawTarget = interaction.fields.getTextInputValue("target") || "";
  const rawNotes = interaction.fields.getTextInputValue("notes") || "";

  const parsed = parseNationTarget(rawTarget);
  if (!parsed)
    return interaction.reply({
      content: "Invalid target.",
      ephemeral: true,
    });

  await interaction.deferReply({ ephemeral: true });

  const targetName =
    (await fetchNationNameViaGraphQL(parsed.id)) || `Nation #${parsed.id}`;

  const slug = targetName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  const channelName = `war-${slug || parsed.id}`;
  const categoryName =
    process.env.WARROOM_CATEGORY_NAME || "WAR ROOMS";

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
    topic: `War room for ${targetName}`,
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

  const tmpRow: WarRoomRow = {
    id: "0",
    guild_id: guild.id,
    channel_id: channel.id,
    control_message_id: null,
    name: targetName,
    created_by_id: user.id,
    target_nation_id: parsed.id,
    target_nation_name: targetName,
    notes: rawNotes.trim() || null,
    member_ids: uniqueIds,
    created_at: new Date(),
  };

  const embed = buildControlEmbed(
    tmpRow,
    user,
    dossier,
    offense,
    defense,
  );

  const controlMsg = await channel.send({
    content: uniqueIds.map((id) => `<@${id}>`).join(" "),
    embeds: [embed],
    components: [buildControlRow()],
  });

  await controlMsg.pin().catch(() => {});

  const saved = await insertWarRoom({
    guildId: tmpRow.guild_id,
    channelId: tmpRow.channel_id,
    controlMessageId: controlMsg.id,
    name: tmpRow.name,
    createdById: tmpRow.created_by_id,
    targetNationId: tmpRow.target_nation_id,
    targetNationName: tmpRow.target_nation_name,
    notes: tmpRow.notes,
    memberIds: tmpRow.member_ids,
  });

  await interaction.editReply({
    content: `✅ War room created: <#${channel.id}>`,
  });
}

// ------------------------------------------------------
// Member add/remove
// ------------------------------------------------------

function parseUserFromModal(raw: string, cache: Map<string, User>): string | null {
  raw = raw.trim();
  const m = raw.match(/^<@!?(\d+)>$/);
  if (m) return m[1];
  if (/^\d{5,}$/.test(raw)) return raw;

  for (const [id, u] of cache.entries()) {
    if (u.username.toLowerCase() === raw.toLowerCase()) return id;
  }
  return null;
}

async function handleMemberModal(interaction: any) {
  if (!interaction.isModalSubmit()) return;
  const [p, kind, id] = interaction.customId.split(":");
  if (p !== "warroom") return;
  if (kind !== "addMember" && kind !== "removeMember") return;

  const { guild } = interaction;
  if (!guild)
    return interaction.reply({
      content: "Guild missing.",
      ephemeral: true,
    });

  const { rows } = await query<WarRoomRow>(
    `SELECT * FROM war_rooms WHERE id=$1`,
    [id],
  );
  const row = rows[0];
  if (!row)
    return interaction.reply({
      content: "War room not found.",
      ephemeral: true,
    });

  const raw = interaction.fields.getTextInputValue("user");
  const cache = new Map<string, User>();
  for (const m of guild.members.cache.values()) cache.set(m.id, m.user);

  const uid = parseUserFromModal(raw, cache);
  if (!uid)
    return interaction.reply({
      content: "Invalid user.",
      ephemeral: true,
    });

  const members = new Set(row.member_ids);

  if (kind === "addMember") {
    members.add(uid);

    const chan = await guild.channels.fetch(row.channel_id).catch(() => null);
    if (chan)
      await (chan as any).permissionOverwrites.edit(uid, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
      });

    await updateWarRoomMembers(row.id, Array.from(members));
    return interaction.reply({
      content: `Added <@${uid}>`,
      ephemeral: true,
    });
  } else {
    if (!members.has(uid))
      return interaction.reply({
        content: "User not in war room.",
        ephemeral: true,
      });

    members.delete(uid);

    const chan = await guild.channels.fetch(row.channel_id).catch(() => null);
    if (chan)
      await (chan as any).permissionOverwrites.edit(uid, {
        ViewChannel: false,
        SendMessages: false,
        ReadMessageHistory: false,
      });

    await updateWarRoomMembers(row.id, Array.from(members));
    return interaction.reply({
      content: `Removed <@${uid}>`,
      ephemeral: true,
    });
  }
}

// ------------------------------------------------------
// Buttons
// ------------------------------------------------------

async function requireRoomFromButton(
  interaction: ButtonInteraction,
): Promise<WarRoomRow | null> {
  const gid = interaction.guildId;
  const cid = interaction.channelId;
  if (!gid || !cid) {
    await interaction.reply({
      content: "Not inside a war room.",
      ephemeral: true,
    });
    return null;
  }

  const row = await getWarRoomByChannel(gid, cid);
  if (!row) {
    await interaction.reply({
      content: "No war room record.",
      ephemeral: true,
    });
    return null;
  }
  return row;
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
      .setCustomId("warroom:refreshDossier")
      .setLabel("Refresh Dossier + Wars")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("warroom:close")
      .setLabel("Close War Room")
      .setStyle(ButtonStyle.Danger),
  );
}

async function handleRefreshDossier(interaction: ButtonInteraction) {
  const row = await requireRoomFromButton(interaction);
  if (!row) return;

  await interaction.deferReply({ ephemeral: true });

  const dossier = await fetchNationDossier(row.target_nation_id);
  const { offense, defense } = await fetchActiveWars(row.target_nation_id);

  const guild = interaction.guild!;
  const chan = await guild.channels.fetch(row.channel_id).catch(() => null);
  if (!chan)
    return interaction.editReply({
      content: "Missing channel.",
    });

  let msg =
    row.control_message_id &&
    (await (chan as any).messages
      .fetch(row.control_message_id)
      .catch(() => null));

  const embed = buildControlEmbed(
    row,
    interaction.user,
    dossier,
    offense,
    defense,
  );

  if (!msg) {
    msg = await (chan as any).send({
      embeds: [embed],
      components: [buildControlRow()],
    });
    await updateWarRoomControlMessage(row.id, msg.id);
  } else {
    await msg.edit({
      embeds: [embed],
      components: [buildControlRow()],
    });
  }

  await interaction.editReply({
    content: "Refreshed.",
  });
}

async function handleClose(interaction: ButtonInteraction) {
  const row = await requireRoomFromButton(interaction);
  if (!row) return;

  const guild = interaction.guild!;
  const chan = await guild.channels.fetch(row.channel_id).catch(() => null);

  if (chan) {
    await (chan as any).send("🔒 War room closing…").catch(() => {});
    await chan.delete().catch(() => {});
  }

  await query(`DELETE FROM war_rooms WHERE id=$1`, [row.id]);

  await interaction.reply({
    content: "Closed.",
    ephemeral: true,
  });
}

// ------------------------------------------------------
// Export command
// ------------------------------------------------------

const command: Command = {
  data: new SlashCommandBuilder()
    .setName("warroom")
    .setDescription("War Room tools")
    .addSubcommand((sub) =>
      sub
        .setName("setup")
        .setDescription("Create a new war room")
        .addStringOption((o) =>
          o
            .setName("target")
            .setDescription("Nation ID or URL")
            .setRequired(true),
        )
        .addUserOption((o) =>
          o
            .setName("member1")
            .setDescription("Member to add"),
        )
        .addUserOption((o) =>
          o.setName("member2").setDescription("Member to add"),
        )
        .addUserOption((o) =>
          o.setName("member3").setDescription("Member to add"),
        ),
    ) as SlashCommandBuilder | SlashCommandSubcommandsOnlyBuilder,

  async execute(interaction) {
    if (interaction.options.getSubcommand() === "setup")
      return handleSetup(interaction);
  },

  async handleModal(interaction) {
    if (!interaction.isModalSubmit()) return;
    if (interaction.customId.startsWith("warroom:setup"))
      return handleSetupModal(interaction);
    if (
      interaction.customId.startsWith("warroom:addMember") ||
      interaction.customId.startsWith("warroom:removeMember")
    )
      return handleMemberModal(interaction);
  },

  async handleButton(interaction) {
    const id = interaction.customId;

    if (id === "warroom:addMember") return handleAddMember(interaction);
    if (id === "warroom:removeMember") return handleRemoveMember(interaction);
    if (id === "warroom:refreshDossier") return handleRefreshDossier(interaction);
    if (id === "warroom:close") return handleClose(interaction);
  },
};

export default command;
