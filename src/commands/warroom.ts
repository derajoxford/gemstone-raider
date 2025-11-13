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
  SlashCommandSubcommandsOnlyBuilder,
  TextInputBuilder,
  TextInputStyle,
  User,
} from "discord.js";
import { query } from "../data/db.js";

// --- Types ------------------------------------------------------------

type Cmd = {
  data: SlashCommandBuilder | SlashCommandSubcommandsOnlyBuilder;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
  handleModal?: (interaction: any) => Promise<void>;
  handleButton?: (interaction: ButtonInteraction) => Promise<void>;
};

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

// --- Helpers ---------------------------------------------------------

function parseNationTarget(raw: string): { id: number; url: string } | null {
  raw = raw.trim();

  // handle nation URL: https://politicsandwar.com/nation/id=12345
  const urlMatch = raw.match(/nation\/id=(\d+)/i);
  if (urlMatch) {
    const id = Number(urlMatch[1]);
    if (Number.isFinite(id) && id > 0) {
      return {
        id,
        url: `https://politicsandwar.com/nation/id=${id}`,
      };
    }
  }

  // bare numeric id
  const id = Number(raw);
  if (Number.isFinite(id) && id > 0) {
    return {
      id,
      url: `https://politicsandwar.com/nation/id=${id}`,
    };
  }

  return null;
}

function nationLink(id: number, name: string | null): string {
  const safeName = name && name.trim().length > 0 ? name.trim() : `Nation #${id}`;
  return `[${safeName}](https://politicsandwar.com/nation/id=${id})`;
}

async function fetchNationNameViaGraphQL(nationId: number): Promise<string | null> {
  const base =
    (process.env.PNW_API_BASE_GRAPHQL || "https://api.politicsandwar.com/graphql").trim();
  const key =
    (process.env.PNW_API_KEY ||
      process.env.PNW_DEFAULT_API_KEY ||
      process.env.PNW_SERVICE_API_KEY ||
      "").trim();

  if (!key) return null;

  const url = `${base}?api_key=${encodeURIComponent(key)}`;
  const body = {
    query: `{ nations(id:${nationId}){ data { nation_name } } }`,
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      console.warn("[warroom] fetchNationNameViaGraphQL non-200", res.status);
      return null;
    }

    const json: any = await res.json();
    if (json.errors || !json.data?.nations?.data?.length) return null;

    const name: string | undefined = json.data.nations.data[0].nation_name;
    return name ?? null;
  } catch (err) {
    console.warn("[warroom] fetchNationNameViaGraphQL error", err);
    return null;
  }
}

// Use REST Nation API for dossier-style stats.
// baseurl/nation/id={nation id}/&key={api key}
async function fetchNationDossier(nationId: number): Promise<DossierInfo | null> {
  const base =
    (process.env.PNW_API_BASE_REST || "https://politicsandwar.com/api").trim();
  const key =
    (process.env.PNW_API_KEY ||
      process.env.PNW_DEFAULT_API_KEY ||
      process.env.PNW_SERVICE_API_KEY ||
      "").trim();

  if (!key) return null;

  const url =
    `${base.replace(/\/+$/, "")}/nation/id=${nationId}/&key=${encodeURIComponent(key)}`;

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    if (!res.ok) {
      console.warn("[warroom] fetchNationDossier REST non-200", res.status);
      return null;
    }

    const data: any = await res.json();
    if (data && data.success === false) {
      console.warn("[warroom] fetchNationDossier success=false", data.error);
      return null;
    }

    // Field names from Nation API (deprecated but still live).
    const score = data.score !== undefined ? Number(data.score) : undefined;
    const cities = data.cities !== undefined ? Number(data.cities) : undefined;
    const soldiers = data.soldiers !== undefined ? Number(data.soldiers) : undefined;
    const tanks = data.tanks !== undefined ? Number(data.tanks) : undefined;
    const aircraft =
      data.aircraft !== undefined ? Number(data.aircraft) : undefined;
    const ships = data.ships !== undefined ? Number(data.ships) : undefined;
    const missiles =
      data.missiles !== undefined ? Number(data.missiles) : undefined;
    const nukes = data.nukes !== undefined ? Number(data.nukes) : undefined;
    const beigeTurnsRaw =
      data.beige_turns_left ?? data.beige_turns ?? data.beige_turns_left;
    const beigeTurns =
      beigeTurnsRaw !== undefined ? Number(beigeTurnsRaw) : undefined;
    const allianceName =
      typeof data.alliance === "string" && data.alliance !== "0"
        ? data.alliance
        : undefined;

    return {
      score: Number.isFinite(score) ? score : undefined,
      cities: Number.isFinite(cities) ? cities : undefined,
      soldiers: Number.isFinite(soldiers) ? soldiers : undefined,
      tanks: Number.isFinite(tanks) ? tanks : undefined,
      aircraft: Number.isFinite(aircraft) ? aircraft : undefined,
      ships: Number.isFinite(ships) ? ships : undefined,
      missiles: Number.isFinite(missiles) ? missiles : undefined,
      nukes: Number.isFinite(nukes) ? nukes : undefined,
      beigeTurns: Number.isFinite(beigeTurns) ? beigeTurns : undefined,
      allianceName,
    };
  } catch (err) {
    console.warn("[warroom] fetchNationDossier REST error", err);
    return null;
  }
}

function formatDossierBlock(d: DossierInfo | null): string {
  if (!d) {
    return "No dossier yet. Press **Refresh Dossier**.";
  }

  const lines: string[] = [];

  if (d.allianceName) {
    lines.push(`👥 **AA:** ${d.allianceName}`);
  }
  if (d.score !== undefined) {
    lines.push(`📈 **Score:** ${d.score.toFixed(2)}`);
  }
  if (d.cities !== undefined) {
    lines.push(`🏙️ **Cities:** ${d.cities}`);
  }

  const milBits: string[] = [];
  if (d.soldiers !== undefined) milBits.push(`🪖 ${d.soldiers.toLocaleString()}`);
  if (d.tanks !== undefined) milBits.push(`🛡️ ${d.tanks.toLocaleString()}`);
  if (d.aircraft !== undefined) milBits.push(`✈️ ${d.aircraft.toLocaleString()}`);
  if (d.ships !== undefined) milBits.push(`🚢 ${d.ships.toLocaleString()}`);
  if (milBits.length) {
    lines.push(`⚔️ **Mil:** ${milBits.join(" • ")}`);
  }

  const boomBits: string[] = [];
  if (d.missiles !== undefined) boomBits.push(`🎯 ${d.missiles}`);
  if (d.nukes !== undefined) boomBits.push(`☢️ ${d.nukes}`);
  if (boomBits.length) {
    lines.push(`💣 **Strategic:** ${boomBits.join(" • ")}`);
  }

  if (d.beigeTurns !== undefined) {
    lines.push(`🟫 **Beige:** ${d.beigeTurns} turns`);
  }

  if (!lines.length) {
    return "No dossier stats available right now. Try again in a minute.";
  }
  return lines.join("\n");
}

function buildControlEmbed(
  row: WarRoomRow,
  creator: User,
  dossier: DossierInfo | null,
): EmbedBuilder {
  const memberMentions =
    row.member_ids && row.member_ids.length
      ? row.member_ids.map((id) => `<@${id}>`).join("\n")
      : "*none*";

  const emb = new EmbedBuilder()
    .setColor(Colors.DarkRed)
    .setTitle(`💥 WAR ROOM — ${row.target_nation_name}`)
    .setDescription(
      [
        `🎯 **Target:** ${nationLink(row.target_nation_id, row.target_nation_name)}`,
        `👤 **Created by:** <@${row.created_by_id}>`,
        "",
        "👥 **Members**",
        memberMentions,
        "",
        "📝 **Notes**",
        row.notes && row.notes.trim().length ? row.notes.trim() : "*none*",
        "",
        "📊 **Dossier**",
        formatDossierBlock(dossier),
        "",
        "Admins: Add/Remove members • Refresh Dossier • Close the war room.",
      ].join("\n"),
    )
    .setFooter({ text: "Gemstone Raider — War Room" })
    .setTimestamp(row.created_at ?? new Date());

  return emb;
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
      .setLabel("Refresh Dossier")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("warroom:close")
      .setLabel("Close War Room")
      .setStyle(ButtonStyle.Danger),
  );
}

// DB helpers ----------------------------------------------------------

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

async function updateWarRoomMembers(
  id: string,
  memberIds: string[],
): Promise<void> {
  await query(`UPDATE war_rooms SET member_ids=$2 WHERE id=$1`, [id, memberIds]);
}

async function updateWarRoomControlMessage(
  id: string,
  controlMessageId: string | null,
): Promise<void> {
  await query(`UPDATE war_rooms SET control_message_id=$2 WHERE id=$1`, [
    id,
    controlMessageId,
  ]);
}

// --- Command implementation ------------------------------------------

async function handleSetup(interaction: ChatInputCommandInteraction) {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({
      content: "This command can only be used in a server.",
      ephemeral: true,
    });
    return;
  }

  const targetRaw = interaction.options.getString("target", true);
  const member1 = interaction.options.getUser("member1");
  const member2 = interaction.options.getUser("member2");
  const member3 = interaction.options.getUser("member3");

  const parsed = parseNationTarget(targetRaw);
  if (!parsed) {
    await interaction.reply({
      content:
        "Could not parse target. Use a nation ID or full nation URL like `https://politicsandwar.com/nation/id=12345`.",
      ephemeral: true,
    });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`warroom:setup:${parsed.id}`)
    .setTitle("Create War Room");

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

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(targetInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(notesInput),
  );

  // stash initial member IDs in the modal customId (gross but simple)
  const members: string[] = [
    interaction.user.id,
    ...(member1 ? [member1.id] : []),
    ...(member2 ? [member2.id] : []),
    ...(member3 ? [member3.id] : []),
  ].filter((v, i, a) => a.indexOf(v) === i);

  // encode member ids after the nation id
  modal.setCustomId(`warroom:setup:${parsed.id}:${members.join(",")}`);

  await interaction.showModal(modal);
}

async function handleSetupModal(interaction: any) {
  if (!interaction.isModalSubmit()) return;
  const { guild, user } = interaction;
  if (!guild) {
    await interaction.reply({
      content: "This command can only be used in a server.",
      ephemeral: true,
    });
    return;
  }

  const [prefix, kind, nidStr, membersStr] =
    interaction.customId.split(":");
  if (prefix !== "warroom" || kind !== "setup") return;

  const nationId = Number(nidStr);
  if (!Number.isFinite(nationId) || nationId <= 0) {
    await interaction.reply({
      content: "Invalid nation ID in modal.",
      ephemeral: true,
    });
    return;
  }

  const memberIds = (membersStr || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const rawTarget = interaction.fields.getTextInputValue("target");
  const rawNotes = interaction.fields.getTextInputValue("notes") || "";

  const parsed = parseNationTarget(rawTarget);
  if (!parsed) {
    await interaction.reply({
      content:
        "Could not parse target nation from the modal. Use an ID or a full URL.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const targetName =
    (await fetchNationNameViaGraphQL(parsed.id)) || `Nation #${parsed.id}`;

  // channel name slug
  const slugBase = targetName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const channelName = `war-${slugBase || parsed.id}`;

  const parent = (interaction.channel && "parent" in interaction.channel)
    ? (interaction.channel as any).parent
    : null;

  const channel = await guild.channels.create({
    name: channelName,
    parent: parent ?? undefined,
    topic: `War room for ${targetName} (#${parsed.id})`,
  });

  const uniqueMemberIds = Array.from(
    new Set<string>([user.id, ...memberIds]),
  );

  if (channel.isTextBased() && "permissionOverwrites" in channel) {
    // allow members to see & talk; leave admin perms alone
    for (const mid of uniqueMemberIds) {
      await channel.permissionOverwrites.edit(mid, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
      } as any);
    }
  }

  const dossier = await fetchNationDossier(parsed.id);

  const row: WarRoomRow = {
    id: "0",
    guild_id: guild.id,
    channel_id: channel.id,
    control_message_id: null,
    name: targetName,
    created_by_id: user.id,
    target_nation_id: parsed.id,
    target_nation_name: targetName,
    notes: rawNotes.trim() || null,
    member_ids: uniqueMemberIds,
    created_at: new Date(),
  };

  const embed = buildControlEmbed(row, user, dossier);
  const controlMsg = await (channel as any).send({
    content:
      uniqueMemberIds.length > 0
        ? uniqueMemberIds.map((id) => `<@${id}>`).join(" ")
        : undefined,
    embeds: [embed],
    components: [buildControlRow()],
  });

  await controlMsg.pin().catch(() => {});

  const saved = await insertWarRoom({
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

  await interaction.editReply({
    content: `✅ War room created: ${channel}`,
  });
}

async function requireWarRoomFromButton(
  interaction: ButtonInteraction,
): Promise<WarRoomRow | null> {
  const guildId = interaction.guildId;
  const channelId = interaction.channelId;
  if (!guildId || !channelId) {
    await interaction.reply({
      content: "This button only works inside a war room.",
      ephemeral: true,
    });
    return null;
  }

  const row = await getWarRoomByChannel(guildId, channelId);
  if (!row) {
    await interaction.reply({
      content: "No war room record found for this channel.",
      ephemeral: true,
    });
    return null;
  }
  return row;
}

async function handleAddMember(interaction: ButtonInteraction) {
  const row = await requireWarRoomFromButton(interaction);
  if (!row) return;

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
}

async function handleRemoveMember(interaction: ButtonInteraction) {
  const row = await requireWarRoomFromButton(interaction);
  if (!row) return;

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
}

function parseUserFromModalField(raw: string, guildUsers: Map<string, User>): string | null {
  raw = raw.trim();
  const mentionMatch = raw.match(/^<@!?(\d+)>$/);
  if (mentionMatch) return mentionMatch[1];
  if (/^\d{5,}$/.test(raw)) return raw;
  for (const [id, u] of guildUsers.entries()) {
    if (u.username.toLowerCase() === raw.toLowerCase()) return id;
  }
  return null;
}

async function handleMemberModal(interaction: any) {
  if (!interaction.isModalSubmit()) return;
  const [prefix, kind, id] = interaction.customId.split(":");
  if (prefix !== "warroom") return;
  if (kind !== "addMember" && kind !== "removeMember") return;

  const { guild } = interaction;
  if (!guild) {
    await interaction.reply({
      content: "Guild missing.",
      ephemeral: true,
    });
    return;
  }

  const { rows } = await query<WarRoomRow>(
    `SELECT * FROM war_rooms WHERE id=$1 LIMIT 1`,
    [id],
  );
  const row = rows[0];
  if (!row) {
    await interaction.reply({
      content: "War room record not found.",
      ephemeral: true,
    });
    return;
  }

  const rawUser = interaction.fields.getTextInputValue("user");
  const cache = new Map<string, User>();
  for (const m of guild.members.cache.values()) {
    cache.set(m.id, m.user);
  }

  const userId = parseUserFromModalField(rawUser, cache);
  if (!userId) {
    await interaction.reply({
      content: "Could not parse that user. Use an ID or a proper mention.",
      ephemeral: true,
    });
    return;
  }

  const members = new Set<string>(row.member_ids || []);

  if (kind === "addMember") {
    members.add(userId);
    try {
      const chan = await guild.channels.fetch(row.channel_id);
      if (chan && chan.isTextBased() && "permissionOverwrites" in chan) {
        await (chan as any).permissionOverwrites.edit(userId, {
          ViewChannel: true,
          SendMessages: true,
          ReadMessageHistory: true,
        } as any);
      }
    } catch {}
    await updateWarRoomMembers(row.id, Array.from(members));
    await interaction.reply({
      content: `✅ Added <@${userId}> to this war room.`,
      ephemeral: true,
    });
  } else {
    if (!members.has(userId)) {
      await interaction.reply({
        content: `That user is not in this war room.`,
        ephemeral: true,
      });
      return;
    }
    members.delete(userId);
    try {
      const chan = await guild.channels.fetch(row.channel_id);
      if (chan && chan.isTextBased() && "permissionOverwrites" in chan) {
        await (chan as any).permissionOverwrites.edit(userId, {
          ViewChannel: false,
          SendMessages: false,
          ReadMessageHistory: false,
        } as any);
      }
    } catch {}
    await updateWarRoomMembers(row.id, Array.from(members));
    await interaction.reply({
      content: `✅ Removed <@${userId}> from this war room.`,
      ephemeral: true,
    });
  }
}

async function handleRefreshDossier(interaction: ButtonInteraction) {
  const row = await requireWarRoomFromButton(interaction);
  if (!row) return;

  await interaction.deferReply({ ephemeral: true });

  const dossier = await fetchNationDossier(row.target_nation_id);

  const guild = interaction.guild!;
  let chan = await guild.channels.fetch(row.channel_id).catch(() => null);
  if (!chan || !chan.isTextBased()) {
    await interaction.editReply({
      content: "Channel missing; cannot refresh dossier.",
    });
    return;
  }

  let controlMsg = null;
  if (row.control_message_id) {
    controlMsg = await (chan as any).messages
      .fetch(row.control_message_id)
      .catch(() => null);
  }
  if (!controlMsg) {
    const msg = await (chan as any).send({
      embeds: [buildControlEmbed(row, interaction.user, dossier)],
      components: [buildControlRow()],
    });
    await updateWarRoomControlMessage(row.id, msg.id);
    controlMsg = msg;
  } else {
    await controlMsg.edit({
      embeds: [buildControlEmbed(row, interaction.user, dossier)],
      components: [buildControlRow()],
    });
  }

  await interaction.editReply({
    content: dossier
      ? "📊 Dossier refreshed."
      : "No dossier data available right now.",
  });
}

async function handleClose(interaction: ButtonInteraction) {
  const row = await requireWarRoomFromButton(interaction);
  if (!row) return;

  const guild = interaction.guild!;
  const chan = await guild.channels.fetch(row.channel_id).catch(() => null);

  if (chan) {
    await chan.send("🔒 War room closing…");
    await chan.delete().catch(() => {});
  }

  await query(`DELETE FROM war_rooms WHERE id=$1`, [row.id]);

  await interaction.reply({
    content: "✅ Closed.",
    ephemeral: true,
  });
}

// --- Exported command -------------------------------------------------

const cmd: Cmd = {
  data: new SlashCommandBuilder()
    .setName("warroom")
    .setDescription("War room tools")
    .addSubcommand((sub) =>
      sub
        .setName("setup")
        .setDescription("Create a new war room")
        .addStringOption((opt) =>
          opt
            .setName("target")
            .setDescription("Nation ID or URL")
            .setRequired(true),
        )
        .addUserOption((opt) =>
          opt
            .setName("member1")
            .setDescription("Member to add to the war room"),
        )
        .addUserOption((opt) =>
          opt
            .setName("member2")
            .setDescription("Second member to add"),
        )
        .addUserOption((opt) =>
          opt
            .setName("member3")
            .setDescription("Third member to add"),
        ),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const sub = interaction.options.getSubcommand();
    if (sub === "setup") {
      await handleSetup(interaction);
      return;
    }

    await interaction.reply({
      content: "Unknown subcommand.",
      ephemeral: true,
    });
  },

  async handleModal(interaction: any) {
    if (!interaction.isModalSubmit()) return;
    if (interaction.customId.startsWith("warroom:setup:")) {
      await handleSetupModal(interaction);
      return;
    }
    if (
      interaction.customId.startsWith("warroom:addMember:") ||
      interaction.customId.startsWith("warroom:removeMember:")
    ) {
      await handleMemberModal(interaction);
      return;
    }
  },

  async handleButton(interaction: ButtonInteraction) {
    const id = interaction.customId;
    if (id === "warroom:addMember") {
      await handleAddMember(interaction);
    } else if (id === "warroom:removeMember") {
      await handleRemoveMember(interaction);
    } else if (id === "warroom:refreshDossier") {
      await handleRefreshDossier(interaction);
    } else if (id === "warroom:close") {
      await handleClose(interaction);
    }
  },
};

export default cmd;
