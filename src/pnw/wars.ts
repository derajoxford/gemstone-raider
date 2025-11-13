// src/pnw/wars.ts
// Fetch ACTIVE wars (offense + defense) via GraphQL (modern schema)

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

  attacker?: { nation_name: string | null };
  defender?: { nation_name: string | null };
};

export async function fetchActiveWars(
  nationId: number,
): Promise<{ offense: WarRecord[]; defense: WarRecord[] }> {
  if (!KEY) return { offense: [], defense: [] };

  const query = `
    query ActiveWars($id: ID!) {
      offense: wars(first: 25, attacker_id: $id) {
        data {
          id
          war_type
          date
          turns_left
          reason
          attacker_id
          defender_id
          attacker { nation_name }
          defender { nation_name }
        }
      }
      defense: wars(first: 25, defender_id: $id) {
        data {
          id
          war_type
          date
          turns_left
          reason
          attacker_id
          defender_id
          attacker { nation_name }
          defender { nation_name }
        }
      }
    }
  `;

  const body = {
    query,
    variables: { id: nationId },
  };

  try {
    const res = await fetch(`${GQL}?api_key=${encodeURIComponent(KEY)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) return { offense: [], defense: [] };
    const json: any = await res.json();
    if (json.errors) return { offense: [], defense: [] };

    const offense: WarRecord[] = (json.data?.offense?.data ?? []).filter(
      (w: any) => w.turns_left && w.turns_left > 0,
    );
    const defense: WarRecord[] = (json.data?.defense?.data ?? []).filter(
      (w: any) => w.turns_left && w.turns_left > 0,
    );

    return { offense, defense };
  } catch {
    return { offense: [], defense: [] };
  }
}
