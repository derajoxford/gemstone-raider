// src/commands/dossier.ts
import {
  SlashCommandBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { Command } from "../types/command.js";
import { query } from "../data/db.js";
import { getGuildSettings } from "../data/settings.js";
import { fetchNationMap } from "../pnw/nations.js";
import { dossierEmbed } from "../ui/dossier.js";

const DECL_MIN = 0.75;
const DECL_MAX = 2.5;

const data: SlashCommandBuilder = new SlashCommandBuilder()
  .setName("dossier")
  .setDescription("Deep intel card for a target nation")
  .addStringOption((o) =>
    o
      .setName("nation_id")
      .setDescription("Target PnW nation ID")
      .setRequired(true),
  );

const execute = async (interaction: ChatInputCommandInteraction) => {
  const gid = interaction.guildId!;
  const nearPct =
    (await getGuildSettings(gid)).near_range_pct ??
    Number(process.env.NEAR_RANGE_PCT ?? 5);

  const nationIdStr = interaction.options.getString("nation_id", true).trim();
  const targetId = Number(nationIdStr);
  if (!Number.isFinite(targetId) || targetId <= 0) {
    await interaction.reply({
      content: "Invalid nation ID.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const me = interaction.user.id;
  const myRow = await query<{ nation_id: number }>(
    "SELECT nation_id FROM user_nation WHERE discord_user_id=$1 AND is_primary=true LIMIT 1",
    [me],
  );
  if (!myRow.rowCount) {
    await interaction.reply({
      content: "Link your nation first with `/link_nation`.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const attackerId = Number(myRow.rows[0].nation_id);

  const map = await fetchNationMap([targetId, attackerId]);
  const target = map[targetId];
  const attacker = map[attackerId];

  if (!target) {
    await interaction.reply({
      content: "Couldn’t load that nation — check the ID.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const window =
    attacker?.score != null
      ? { min: attacker.score * DECL_MIN, max: attacker.score * DECL_MAX }
      : { min: 0, max: 0 };

  const status =
    attacker?.score != null && target?.score != null
      ? rangeStatus(attacker.score, target.score, nearPct)
      : { inRange: false, nearRange: false };

  const payload = dossierEmbed({
    target,
    attacker,
    nearPct,
    window,
    status: status as any,
  });

  await interaction.reply({ ...(payload as any), flags: MessageFlags.Ephemeral });
};

function rangeStatus(attackerScore: number, targetScore: number, nearPct: number) {
  const min = attackerScore * DECL_MIN;
  const max = attackerScore * DECL_MAX;
  const inRange = targetScore >= min && targetScore <= max;

  const lowNearMin = min * (1 - nearPct / 100);
  const highNearMax = max * (1 + nearPct / 100);

  let nearRange = false;
  let deltaPct: number | undefined;
  let side: "below" | "above" | undefined;

  if (!inRange) {
    if (targetScore >= lowNearMin && targetScore < min) {
      nearRange = true;
      side = "below";
      deltaPct = ((targetScore - min) / min) * 100;
    } else if (targetScore > max && targetScore <= highNearMax) {
      nearRange = true;
      side = "above";
      deltaPct = ((targetScore - max) / max) * 100;
    }
  }

  return { inRange, nearRange, deltaPct, side };
}

const command: Command = { data, execute };
export default command;
