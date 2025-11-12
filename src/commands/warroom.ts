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

type Cmd = import("../types/command.js").Command;

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

  let m = s.match(/[?&]id=(\d{1,9})/i) || s.match(/\/id=(\d{1,9})/i);
  if (!m) {
    const all = [...s.matchAll(/(\d{3,9})/g)];
    if (all.length) m = all[all.length - 1];
  }
  if (!m) return null;

  const id = Number(m[1]);
  if (!Number.isFinite(id) || id <= 0) return null;

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
  if (d.nukes != null) mil.push(`☢️ ${formatNum(d.nukes)}`);
  if (mil.length) lines.push(`🧷 **Military:** ${mil.join(" / ")}`);
  if (d.beige != null) lines.push(`🟫 **Beige:** ${formatNum(d.beige)} turns`);
  return lines.length ? lines.join("\n") : "_No data_";
}

function formatNum(n: number) {
  try {
    if (Math.abs(n) >= 1000) return Intl.NumberFormat("en-US").format(Math.round(n));
    return `${n}`;
  } catch {
    return `${n}`;
  }
}

function controlEmbed(opts: {
  nationName: string;
  openerId: string;
  targetUrl: string;
  notes?: string | null;
  members: string[];
  dossier?: Dossier | null;
}) {
  const preview =
    opts.members.length > 0
      ? opts.members.slice(0, 10).map((id) => userMention(id)).join(" • ")
      : "_none_";

  const emb = new EmbedBuilder()
    .setColor(0xd32f2f) // brand red
    .setTitle(`💥 WAR ROOM — ${opts.nationName}`)
    .setDescription(`🎯 **Target:** [${opts.nationName}](${opts.targetUrl})\n👤 **Created by:** ${userMention(opts.openerId)}`)
    .addFields({ name: "👥 Members", value: preview })
    .setFooter({ text: "Admins: Add/Remove members • Refresh Dossier • Close War Room" })
    .setTimestamp(Date.now());

  if (opts.notes && opts.notes.trim()) {
    emb.addFields({ name: "📝 Notes", value: opts.notes.trim().slice(0, 1024) });
  }

  const dossierTxt = renderDossier(opts.dossier ?? null);
  emb.addFields({ name: "📊 Dossier", value: dossierTxt });

  return emb;
}

function canManage(member: GuildMember, creatorId: string) {
  return member.id === creatorId || member.permissions.has(PermissionFlagsBits.ManageChannels);
}

async function refreshControlEmbed(ch: TextChannel, roomId: number, dossier: Dossier | null = null) {
  const { rows } = await query("SELECT * FROM war_rooms WHERE id=$1", [roomId]);
  const wr = rows[0];
  if (!wr) return;
  const msgId: string | null = wr.control_message_id;
  if (!msgId) return;
  const msg = await ch.messages.fetch(msgId).catch(() => null);
  if (!msg) return;

  const emb = controlEmbed({
    nationName: wr.target_nation_name,
    openerId: wr.created_by_id,
    targetUrl: `https://politicsandwar.com/nation/id=${wr.target_nation_id}`,
    notes: wr.notes,
    members: wr.member_ids || [],
    dossier,
  });
  await msg.edit({ embeds: [emb], components: [controlButtons(roomId)] }).catch(() => {});
}

async function tryUpdateDossier(roomId: number) {
  const { rows } = await query("SELECT * FROM war_rooms WHERE id=$1", [roomId]);
  const wr = rows[0];
  if (!wr) return;

  const ch = (await globalThis
    .__discordClient?.channels?.fetch(wr.channel_id)
    .catch(() => null)) as TextChannel | null;
  if (!ch) return;

  const dossier = await fetchNationDossier(wr.target_nation_id).catch(() => null);
  await refreshControlEmbed(ch, roomId, dossier);
}

declare global {
  // eslint-disable-next-line no-var
  var __discordClient: any;
}

/* ---------- Command ---------- */

const cmd: Cmd = {
  data: new SlashCommandBuilder()
    .setName("warroom")
    .setDescription("Create/manage a War Room (modal collects notes)")
    .addSubcommand((sc) => {
      let b = sc
        .setName("setup")
        .setDescription("Select target + up to 10 members, then add notes in modal")
        .addStringOption((o) =>
          o.setName("target").setDescription("Nation ID or full nation URL").setRequired(true),
        );
      for (let i = 1; i <= 10; i++) {
        b = b.addUserOption((o) => o.setName(`member${i}`).setDescription(`Add member #${i}`).setRequired(false));
      }
      return b;
    }),

  async execute(i: ChatInputCommandInteraction) {
    // make client reachable for background dossier update
    // @ts-ignore
    globalThis.__discordClient = i.client;

    if (!i.inGuild() || !i.guildId) {
      await i.reply({ content: "Run this in a server.", ephemeral: true });
      return;
    }
    const sub = i.options.getSubcommand(false);
    if (sub !== "setup") {
      await i.reply({ ephemeral: true, content: "Use **/warroom setup**." });
      return;
    }

    const raw = i.options.getString("target", true);
    const norm = normalizeTarget(raw);
    if (!norm) {
      await i.reply({ content: "Invalid target. Provide a nation ID or a valid nation URL.", ephemeral: true });
      return;
    }

    const pre: string[] = [];
    for (let idx = 1; idx <= 10; idx++) {
      const u = i.options.getUser(`member${idx}`, false);
      if (u) pre.push(u.id);
    }
    const preUnique = Array.from(new Set(pre));

    pendingSetup.set(setupKey(i.guildId, i.user.id), {
      targetId: norm.id,
      targetUrl: norm.url,
      preMembers: preUnique,
    });

    const modal = new ModalBuilder().setCustomId("war:setup").setTitle("War Room — Confirm Details");

    const urlPreview = new TextInputBuilder()
      .setCustomId("target_url_preview")
      .setLabel("Target URL (for reference)")
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setValue(norm.url.slice(0, 100));

    const notes = new TextInputBuilder()
      .setCustomId("notes")
      .setLabel("Notes (visible to everyone)")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(false)
      .setMaxLength(1024);

    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(urlPreview),
      new ActionRowBuilder<TextInputBuilder>().addComponents(notes),
    );

    await i.showModal(modal);
  },

  async handleButton(i: ButtonInteraction): Promise<boolean> {
    const cid = i.customId || "";
    if (!cid.startsWith("war:")) return false;
    if (!i.inGuild() || !i.guildId) return true;

    const [_, action, idStr] = cid.split(":");
    const roomId = Number(idStr || 0);
    if (!Number.isFinite(roomId) || roomId <= 0) {
      await i.reply({ ephemeral: true, content: "Invalid room id." });
      return true;
    }

    const me = await i.guild!.members.fetch(i.user.id);
    const { rows } = await query("SELECT * FROM war_rooms WHERE id=$1", [roomId]);
    const wr = rows[0];
    if (!wr) {
      await i.reply({ ephemeral: true, content: "War Room not found." });
      return true;
    }

    if (action === "refresh") {
      if (!canManage(me, wr.created_by_id)) {
        await i.reply({ ephemeral: true, content: "You can't refresh the dossier." });
        return true;
      }
      await i.deferReply({ ephemeral: true });
      const dossier = await fetchNationDossier(wr.target_nation_id).catch(() => null);
      const ch = (await i.client.channels.fetch(wr.channel_id).catch(() => null)) as TextChannel | null;
      if (ch) await refreshControlEmbed(ch, roomId, dossier);
      await i.editReply(dossier ? "📊 Dossier refreshed." : "No dossier data available right now.");
      return true;
    }

    if (!canManage(me, wr.created_by_id)) {
      await i.reply({ ephemeral: true, content: "You can't manage this War Room." });
      return true;
    }

    if (action === "close") {
      await i.deferReply({ ephemeral: true });
      await query("DELETE FROM war_rooms WHERE id=$1", [roomId]).catch(() => {});
      const ch = (await i.client.channels.fetch(wr.channel_id).catch(() => null)) as TextChannel | null;
      if (ch) await ch.delete("War Room closed").catch(() => {});
      await i.editReply("✅ Closed.");
      return true;
    }

    if (action === "add" || action === "remove") {
      const modal = new ModalBuilder()
        .setCustomId(`war:${action}:modal:${roomId}`)
        .setTitle(action === "add" ? "Add Members" : "Remove Members");
      const field = new TextInputBuilder()
        .setCustomId("members")
        .setLabel("Members (mentions or IDs, space/newline separated)")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true);
      modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(field));
      await i.showModal(modal);
      return true;
    }

    return true;
  },

  async handleModal(i: ModalSubmitInteraction): Promise<boolean> {
    if (!i.inGuild() || !i.guildId) return false;

    if (i.customId === "war:setup") {
      const key = setupKey(i.guildId!, i.user.id);
      const cached = pendingSetup.get(key);
      if (!cached) {
        await i.reply({ ephemeral: true, content: "Setup expired. Re-run /warroom setup." });
        return true;
      }

      await i.deferReply({ ephemeral: true });

      const { targetId, targetUrl, preMembers } = cached;

      const nationName = (await fetchNationName(targetId)) ?? `Nation #${targetId}`;

      const initialMembers: string[] = [];
      for (const uid of preMembers) {
        try {
          await i.guild!.members.fetch(uid);
          initialMembers.push(uid);
        } catch {}
      }

      let cat = i.guild!.channels.cache.find(
        (c) => c.type === ChannelType.GuildCategory && c.name.toUpperCase() === CATEGORY_NAME.toUpperCase(),
      );
      if (!cat) {
        cat = await i.guild!.channels.create({
          name: CATEGORY_NAME,
          type: ChannelType.GuildCategory,
          reason: "War Room category",
        });
      }

      const overwrites: any[] = [
        { id: i.guild!.roles.everyone.id, deny: ["ViewChannel", "SendMessages", "ReadMessageHistory"] },
        { id: i.client.user!.id, allow: ["ViewChannel", "SendMessages", "ReadMessageHistory", "ManageChannels", "ManageMessages"] },
        { id: i.user.id, allow: ["ViewChannel", "SendMessages", "ReadMessageHistory"] },
        ...initialMembers.map((id) => ({ id, allow: ["ViewChannel", "SendMessages", "ReadMessageHistory"] })),
      ];

      const ch = await i.guild!.channels.create({
        name: `wr-${slug(nationName)}`,
        type: ChannelType.GuildText,
        parent: (cat as any).id,
        permissionOverwrites: overwrites as any,
        reason: `War Room created by ${i.user.tag}`,
      });

      const notes = i.fields.getTextInputValue("notes")?.trim() || "";

      const ins = await query(
        `INSERT INTO war_rooms
         (guild_id, channel_id, control_message_id, name, created_by_id,
          target_nation_id, target_nation_name, notes, member_ids)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id`,
        [
          i.guildId!,
          (ch as any).id,
          null,
          nationName,
          i.user.id,
          targetId,
          nationName,
          notes || null,
          initialMembers,
        ],
      );
      const roomId: number = ins.rows[0].id;

      const contentPing = initialMembers.length ? initialMembers.map((x) => `<@${x}>`).join(" ") : "";
      const emb = controlEmbed({
        nationName,
        openerId: i.user.id,
        targetUrl,
        notes,
        members: initialMembers,
        dossier: null,
      });
      const msg = await (ch as TextChannel).send({
        content: contentPing,
        embeds: [emb],
        components: [controlButtons(roomId)],
        allowedMentions: initialMembers.length ? { users: initialMembers } : { parse: [] },
      });
      await msg.pin().catch(() => {});

      await query("UPDATE war_rooms SET control_message_id=$1 WHERE id=$2", [msg.id, roomId]);

      tryUpdateDossier(roomId).catch(() => {});

      pendingSetup.delete(key);
      await i.editReply(`✅ Created <#${(ch as any).id}> — target **${nationName}** (#${targetId}).`);
      return true;
    }

    if (i.customId.startsWith("war:add:modal:") || i.customId.startsWith("war:remove:modal:")) {
      const roomId = Number(i.customId.split(":").pop() || 0);
      const { rows } = await query("SELECT * FROM war_rooms WHERE id=$1", [roomId]);
      const wr = rows[0];
      if (!wr) {
        await i.reply({ ephemeral: true, content: "War Room not found." });
        return true;
      }

      const me = await i.guild!.members.fetch(i.user.id);
      if (!canManage(me, wr.created_by_id)) {
        await i.reply({ ephemeral: true, content: "You can't manage this War Room." });
        return true;
      }

      await i.deferReply({ ephemeral: true });

      const raw = i.fields.getTextInputValue("members") || "";
      const ids = parseUserTokens(raw);

      const valid: string[] = [];
      for (const uid of ids) {
        try {
          await i.guild!.members.fetch(uid);
          valid.push(uid);
        } catch {}
      }
      const ch = (await i.client.channels.fetch(wr.channel_id).catch(() => null)) as TextChannel | null;
      if (!ch) {
        await i.editReply("Channel not found.");
        return true;
      }

      if (i.customId.startsWith("war:add:modal:")) {
        for (const uid of valid) {
          await ch.permissionOverwrites.edit(uid, {
            ViewChannel: true,
            SendMessages: true,
            ReadMessageHistory: true,
          }).catch(() => {});
        }
        const merged = Array.from(new Set([...(wr.member_ids || []), ...valid]));
        await query("UPDATE war_rooms SET member_ids=$1 WHERE id=$2", [merged, roomId]);
        await refreshControlEmbed(ch, roomId);
        await i.editReply(`✅ Added ${valid.map((x) => `<@${x}>`).join(" ") || "(none)"}`);
      } else {
        for (const uid of valid) {
          await ch.permissionOverwrites.delete(uid).catch(() => {});
        }
        const filtered = (wr.member_ids || []).filter((x: string) => !valid.includes(x));
        await query("UPDATE war_rooms SET member_ids=$1 WHERE id=$2", [filtered, roomId]);
        await refreshControlEmbed(ch, roomId);
        await i.editReply(`🧹 Removed ${valid.map((x) => `<@${x}>`).join(" ") || "(none)"}`);
      }

      return true;
    }

    return false;
  },
};

export default cmd;
