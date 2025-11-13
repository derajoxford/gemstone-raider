// src/pnw/wars.ts
const GQL =
  (process.env.PNW_API_BASE_GRAPHQL ||
    "https://api.politicsandwar.com/graphql").trim();
const KEY =
  (process.env.PNW_API_KEY ||
    process.env.PNW_DEFAULT_API_KEY ||
    process.env.PNW_SERVICE_API_KEY ||
    "").trim();

export type WarRecord = {
  id: number;
  war_type: string | null;
  date: string | null;
  turns_left: number | null;
  reason: string | null;
  attacker_id: number;
  defender_id: number;
  attacker?: { nation_name: string | null } | null;
  defender?: { nation_name: string | null } | null;
};

type GqlWarsResp = {
  data?: {
    offense?: { data?: WarRecord[] };
    defense?: { data?: WarRecord[] };
  };
  errors?: any;
};

export async function fetchActiveWars(
  nationId: number,
): Promise<{ offense: WarRecord[]; defense: WarRecord[] }> {
  if (!KEY) return { offense: [], defense: [] };

  const query = `
    query ActiveWars($id: ID!) {
      offense: wars(first: 25, attacker_id: $id) {
        data {
          id war_type date turns_left reason attacker_id defender_id
          attacker { nation_name }
          defender { nation_name }
        }
      }
      defense: wars(first: 25, defender_id: $id) {
        data {
          id war_type date turns_left reason attacker_id defender_id
          attacker { nation_name }
          defender { nation_name }
        }
      }
    }
  `;

  try {
    const res = await fetch(`${GQL}?api_key=${encodeURIComponent(KEY)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { id: nationId } }),
    });
    if (!res.ok) return { offense: [], defense: [] };
    const json = (await res.json()) as GqlWarsResp;
    if (json.errors) return { offense: [], defense: [] };

    const offense = (json.data?.offense?.data ?? []).filter(
      (w) => (w.turns_left ?? 0) > 0,
    );
    const defense = (json.data?.defense?.data ?? []).filter(
      (w) => (w.turns_left ?? 0) > 0,
    );

    return { offense, defense };
  } catch {
    return { offense: [], defense: [] };
  }
}
