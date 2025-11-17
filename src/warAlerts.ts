// src/warAlerts.ts
import * as https from "https";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  Channel,
  Client,
  EmbedBuilder,
  TextChannel,
} from "discord.js";

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
  const offenseChannelId = (process.env.WAR_ALERTS_OFFENSE_CHANNEL_ID || "").trim();
  const defenseChannelId = (process.env.WAR_ALERTS_DEFENSE_CHANNEL_ID || "").trim();
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
    "ms",
  );

  async function pollOnce() {
    try {
      const wars = await fetchWars(apiKey);

      const activeWars = wars.filter(
        (w) =>
          w.winner_id === "0" &&
          (w.att_alliance_id === allianceId || w.def_alliance_id === allianceId),
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
