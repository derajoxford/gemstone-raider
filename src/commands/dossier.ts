import { SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import type { Command } from "../types/command.js";
import { query } from "../data/db.js";
import { getGuildSettings } from "../data/settings.js";
import { fetchNationMap } from "../pnw/nations.js";
import { dossierEmbed } from "../ui/dossier.js";

const DECL_MIN = 0.75;
const DECL_MAX = 2.50;

const data = new SlashCommandBuilder()
  .setName("dossier")
  .setDescription("Deep intel card for a target nation")
  .addStringOption(o =>
    o.setName("nation_id")
      .setDescription("Target PnW nation ID")
      .setRequired(true)
  );

const execute = async (interaction: ChatInputCommandInteraction) => {
  const gid = interaction.guildId!;
  const nearPct = (await getGuildSettings(gid)).near_range_pct ?? Number(process.env.NEAR_RANGE_PCT ?? 5);

  const nationIdStr = interaction.options.getString("nation_id", true).trim();
  const targetId = Number(nationIdStr);
  if (!Number.isFinite(targetId) || targetId <= 0) {
    await interaction.reply({ content: "Invalid nation ID.", ephemeral: true });
    return;
  }

  // Who's asking? Get their primary linked nation.
  const me = interaction.user.id;
  const myRow = await query<{ nation_id: number }>(
    "SELECT nation_id FROM user_nation WHERE discord_user_id=$1 AND is_primary=true LIMIT 1",
    [me]
  );
  if (!myRow.rowCount) {
    await interaction.reply({ content: "Link your nation first with `/link_nation`.", ephemeral: true });
    return;
  }
  const attackerId = Number(myRow.rows[0].nation_id);

  // Pull target + attacker scores
  const map = await fetchNationMap([targetId, attackerId]);
  const target = map[targetId];
  const attacker = map[attackerId];

  if (!target) {
    await interaction.reply({ content: "Couldn’t load that nation — check the ID.", ephemeral: true });
    return;
  }

  const attScore = attacker?.score ?? null;
  const tarScore = target?.score ?? null;

  let status = { inRange: false, nearRange: false, deltaPct: undefined as number | undefined, side: undefined as "below" | "above" | undefined };
  let window = { min: 0, max: 0 };

  if (attScore != null && tarScore != null) {
    window = { min: attScore * DECL_MIN, max: attScore * DECL_MAX };
    status = rangeStatus(attScore, tarScore, nearPct);
  }

  const payload = dossierEmbed({
    target: { id: targetId, name: target?.name ?? "Unknown", score: tarScore },
    attacker: { id: attackerId, name: attacker?.name, score: attScore },
    nearPct,
    window,
    status
  });

  // Dossier is noisy; return ephemeral so pros can pull it on demand
  await interaction.reply({ ...(payload as any), ephemeral: true });
};

function rangeStatus(attackerScore: number, targetScore: number, nearPct: number) {
  const min = attackerScore * DECL_MIN;
  const max = attackerScore * DECL_MAX;
  const inRange = targetScore >= min && targetScore <= max;

  // near-range windows
  const lowNearMin = min * (1 - (nearPct / 100));
  const highNearMax = max * (1 + (nearPct / 100));

  let nearRange = false;
  let deltaPct: number | undefined;
  let side: "below" | "above" | undefined;

  if (!inRange) {
    if (targetScore >= lowNearMin && targetScore < min) {
      nearRange = true;
      side = "below";
      deltaPct = ((targetScore - min) / min) * 100; // negative
    } else if (targetScore > max && targetScore <= highNearMax) {
      nearRange = true;
      side = "above";
      deltaPct = ((targetScore - max) / max) * 100; // positive
    }
  }

  return { inRange, nearRange, deltaPct, side };
}

const command: Command = { data, execute };
export default command;
