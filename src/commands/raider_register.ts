// src/commands/raider_register.ts
import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
} from "discord.js";
import { query } from "../data/db.js";

type Command = import("../types/command.js").Command;

// --- helpers (same parsing style as warroom) ---

function parseNationTarget(raw: string): { id: number; url: string } | null {
  raw = raw.trim();

  // Try PnW URL first
  const urlMatch = raw.match(/nation\/id=(\d+)/i);
  if (urlMatch) {
    const id = Number(urlMatch[1]);
    if (id > 0) {
      return {
        id,
        url: `https://politicsandwar.com/nation/id=${id}`,
      };
    }
  }

  // Fallback: plain numeric ID
  const id = Number(raw);
  if (Number.isFinite(id) && id > 0) {
    return {
      id,
      url: `https://politicsandwar.com/nation/id=${id}`,
    };
  }

  return null;
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

// --- command ---

const command: Command = {
  data: new SlashCommandBuilder()
    .setName("raider_register")
    .setDescription("Register your PnW nation with Raider for auto war rooms")
    .addStringOption((opt) =>
      opt
        .setName("nation")
        .setDescription("Your nation ID or PnW nation URL")
        .setRequired(true),
    ),
  async execute(interaction: ChatInputCommandInteraction) {
    const raw = interaction.options.getString("nation", true);
    const parsed = parseNationTarget(raw);

    if (!parsed) {
      await interaction.reply({
        content:
          "❌ I couldn't parse that nation. Please provide a nation ID like `246232` or a full PnW nation URL such as `https://politicsandwar.com/nation/id=246232`.",
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const userId = interaction.user.id;
    const nationId = parsed.id;

    let nationName: string | null = null;
    try {
      nationName = await fetchNationNameViaGraphQL(nationId);
    } catch {
      // non-fatal
    }

    try {
      await query(
        `
        INSERT INTO watchlist (nation_id, discord_user_id)
        VALUES ($1, $2)
      `,
        [nationId, userId],
      );
    } catch (err) {
      console.error("[raider_register] failed inserting into watchlist", {
        nationId,
        userId,
        err,
      });
      await interaction.editReply({
        content:
          "❌ Something went wrong saving your registration. Please tell a dev to check the logs.",
      });
      return;
    }

    const prettyName = nationName
      ? `**${nationName}** (#${nationId})`
      : `nation **#${nationId}**`;

    await interaction.editReply({
      content: `✅ Registered ${prettyName} to <@${userId}>.\n\nWhen that nation is the **defender** in a war, Raider will automatically open a war room vs the attacker and add you to it.`,
    });
  },
};

export default command;
