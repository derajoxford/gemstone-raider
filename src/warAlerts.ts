// src/warAlerts.ts
import * as https from "https";
import {
  Client,
  TextChannel,
  EmbedBuilder,
  Channel,
} from "discord.js";

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

interface WarMessageRef {
  warId: string;
  channelId: string;
  messageId: string;
  isDefensive: boolean;
}

const warMessageMap = new Map<string, WarMessageRef>();

function fetchWars(apiKey: string): Promise<War[]> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ query: WAR_QUERY });

    const req = https.request(
      {
        hostname: "api.politicsandwar.com",
        path: `/graphql?api_key=${apiKey}`,
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
          try {
            if (res.statusCode && res.statusCode >= 400) {
              console.error(
                "[war-alerts] HTTP error",
                res.statusCode,
                body.slice(0, 300)
              );
              return resolve([]);
            }
            const json = JSON.parse(body) as WarApiResponse;
            if (json.errors && json.errors.length > 0) {
              console.error(
                "[war-alerts] GraphQL errors",
                json.errors.map((e) => e.message).join("; ")
              );
              return resolve([]);
            }
            const wars = json.data?.wars?.data ?? [];
            resolve(wars);
          } catch (err) {
            console.error("[war-alerts] failed to parse response", err);
            resolve([]);
          }
        });
      }
    );

    req.on("error", (err) => {
      console.error("[war-alerts] request error", err);
      resolve([]);
    });

    req.write(payload);
    req.end();
  });
}

function buildWarEmbed(war: War, ourAllianceId: string): EmbedBuilder {
  const isOffense = war.att_alliance_id === ourAllianceId;
  const isDefense = war.def_alliance_id === ourAllianceId;

  const titlePrefix = isOffense ? "⚔️ Offensive War" : isDefense ? "🛡️ Defensive War" : "⚔️ War";
  const status = war.winner_id === "0" ? "Active" : "Ended";

  const startedIso = war.date;
  const turnsLeft = war.turns_left;

  const attackerUrl = `https://politicsandwar.com/nation/id=${war.att_id}`;
  const defenderUrl = `https://politicsandwar.com/nation/id=${war.def_id}`;

  const attackerAllianceName =
    war.attacker.alliance?.name ?? (war.att_alliance_id === "0" ? "None" : `Unknown (#${war.att_alliance_id})`);
  const defenderAllianceName =
    war.defender.alliance?.name ?? (war.def_alliance_id === "0" ? "None" : `Unknown (#${war.def_alliance_id})`);

  const attackerHasGround = war.ground_control === war.att_id;
  const defenderHasGround = war.ground_control === war.def_id;

  const attackerHasNaval = war.naval_blockade === war.att_id;
  const defenderHasNaval = war.naval_blockade === war.def_id;

  const attackerFieldValue = [
    `**[${war.attacker.nation_name}](${attackerUrl})**`,
    `Alliance: ${attackerAllianceName}`,
    `Nation ID: ${war.att_id}`,
    `Ground Control: ${attackerHasGround ? "✅" : "❌"}`,
    `Naval Blockade: ${attackerHasNaval ? "✅" : "❌"}`,
  ].join("\n");

  const defenderFieldValue = [
    `**[${war.defender.nation_name}](${defenderUrl})**`,
    `Alliance: ${defenderAllianceName}`,
    `Nation ID: ${war.def_id}`,
    `Ground Control: ${defenderHasGround ? "✅" : "❌"}`,
    `Naval Blockade: ${defenderHasNaval ? "✅" : "❌"}`,
  ].join("\n");

  const ourSide = isOffense ? "Attacker" : isDefense ? "Defender" : "Unknown";

  const description = [
    `Type: ${war.war_type}`,
    `Started: ${startedIso}`,
    `Status: ${status}`,
    `Turns Left: ${turnsLeft}`,
  ].join(" • ");

  const embed = new EmbedBuilder()
    .setTitle(`${titlePrefix} #${war.id}`)
    .setDescription(description)
    .addFields(
      { name: "Attacker", value: attackerFieldValue, inline: true },
      { name: "Defender", value: defenderFieldValue, inline: true },
      { name: "Our Side", value: ourSide, inline: false }
    )
    .setColor(isDefense ? 0xff4d4d : 0xffa200);

  return embed;
}

function isTextChannel(ch: Channel | null): ch is TextChannel {
  return !!ch && (ch as TextChannel).send !== undefined;
}

export function startWarAlertsFromEnv(client: Client): void {
  const enabled =
    process.env.WAR_ALERTS_ENABLED === "1" ||
    process.env.WAR_ALERTS_ENABLED === "true";

  if (!enabled) {
    console.log("[war-alerts] disabled via WAR_ALERTS_ENABLED");
    return;
  }

  const apiKey = (process.env.PNW_GRAPH_KEY || process.env.PNW_API_KEY || "").trim();
  const allianceId = (process.env.WAR_ALERTS_AID || "").trim();
  const guildId = (process.env.WAR_ALERTS_GUILD_ID || "").trim();
  const offenseChannelId = (process.env.WAR_ALERTS_OFFENSE_CHANNEL_ID || "").trim();
  const defenseChannelId = (process.env.WAR_ALERTS_DEFENSE_CHANNEL_ID || "").trim();
  const defensePingRoleId = (process.env.WAR_ALERTS_DEFENSE_PING_ROLE_ID || "").trim() || undefined;
  const intervalMs = Number(process.env.WAR_ALERTS_INTERVAL_MS || "60000");

  if (!apiKey) {
    console.warn("[war-alerts] PNW_GRAPH_KEY or PNW_API_KEY not set, cannot start war alerts.");
    return;
  }
  if (!allianceId || !guildId || !offenseChannelId || !defenseChannelId) {
    console.warn(
      "[war-alerts] missing config. Need WAR_ALERTS_AID, WAR_ALERTS_GUILD_ID, WAR_ALERTS_OFFENSE_CHANNEL_ID, WAR_ALERTS_DEFENSE_CHANNEL_ID."
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
    "ms"
  );

  async function pollOnce() {
    try {
      const wars = await fetchWars(apiKey);

      const activeWars = wars.filter(
        (w) =>
          w.winner_id === "0" &&
          (w.att_alliance_id === allianceId || w.def_alliance_id === allianceId)
      );

      if (activeWars.length === 0) {
        return;
      }

      const offenseChannelRaw = await client.channels.fetch(offenseChannelId).catch(() => null);
      const defenseChannelRaw = await client.channels.fetch(defenseChannelId).catch(() => null);

      const offenseChannel = isTextChannel(offenseChannelRaw) ? offenseChannelRaw : null;
      const defenseChannel = isTextChannel(defenseChannelRaw) ? defenseChannelRaw : null;

      if (!offenseChannel || !defenseChannel) {
        console.warn("[war-alerts] offense/defense channels not found or not text-based.");
        return;
      }

      for (const war of activeWars) {
        const isOffense = war.att_alliance_id === allianceId;
        const isDefense = war.def_alliance_id === allianceId;
        const key = `${guildId}:${war.id}`;

        const embed = buildWarEmbed(war, allianceId);
        const channel = isOffense ? offenseChannel : defenseChannel;

        const existing = warMessageMap.get(key);
        if (!existing) {
          // New war: create a message, ping only once for defensive wars
          const content =
            isDefense && defensePingRoleId ? `<@&${defensePingRoleId}>` : undefined;

          const msg = await channel.send({
            content,
            embeds: [embed],
          });

          warMessageMap.set(key, {
            warId: war.id,
            channelId: channel.id,
            messageId: msg.id,
            isDefensive: isDefense,
          });
        } else {
          // Existing war: edit the existing embed, do NOT ping again
          try {
            const msg = await channel.messages.fetch(existing.messageId);
            await msg.edit({ embeds: [embed] });
          } catch (err) {
            // Message missing or fetch failed; drop reference so it will recreate next poll
            warMessageMap.delete(key);
          }
        }
      }
    } catch (err) {
      console.error("[war-alerts] poll error", err);
    }
  }

  // Run immediately once, then every interval
  void pollOnce();
  setInterval(() => {
    void pollOnce();
  }, intervalMs);
}
