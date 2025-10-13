// Rich nation fetcher (GraphQL-first, REST fallback) with defensive parsing.
// Fields: id, name, score, alliance(id/name), cities, war counts, timers, activity, military.

export type NationDetail = {
  id: number;
  name: string;
  score: number | null;

  allianceId: number | null;
  allianceName: string | null;
  cities: number | null;

  offensiveWars: number | null;
  defensiveWars: number | null;

  lastActiveMinutes: number | null;
  beigeTurns: number | null;
  vmTurns: number | null;

  soldiers: number | null;
  tanks: number | null;
  aircraft: number | null;
  ships: number | null;
  missiles: number | null;
  nukes: number | null;
};

const GQL = process.env.PNW_API_BASE_GRAPHQL || "https://api.politicsandwar.com/graphql";
const REST = process.env.PNW_API_BASE_REST || "https://politicsandwar.com/api";
const KEY  = process.env.PNW_API_KEY || "";

export async function fetchNationMap(ids: number[]): Promise<Record<number, NationDetail>> {
  if (!ids.length || !KEY) return {};
  const uniq = [...new Set(ids.map(n => Number(n)).filter(n => Number.isFinite(n) && n > 0))];
  if (!uniq.length) return {};

  const viaGql = await tryGraphQL(uniq).catch(() => null);
  if (viaGql && Object.keys(viaGql).length) return viaGql;

  const viaRest = await tryREST(uniq).catch(() => null);
  return viaRest ?? {};
}

// -------------------- GraphQL attempt --------------------
async function tryGraphQL(ids: number[]): Promise<Record<number, NationDetail>> {
  // Schema names vary; we ask for common fields and tolerate missing ones.
  const q = /* GraphQL */ `
    query Nations($ids: [Int!]!) {
      nations(ids: $ids) {
        id
        name
        score
        alliance { id name }
        cities
        last_active_minutes
        beige_turns
        vacation_mode_turns
        soldiers
        tanks
        aircraft
        ships
        missiles
        nukes
        offensive_wars { id }
        defensive_wars { id }
      }
    }
  `;
  const res = await fetch(GQL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": KEY },
    body: JSON.stringify({ query: q, variables: { ids } })
  });
  if (!res.ok) throw new Error("GraphQL nations fetch failed: " + res.status);
  const json = await res.json() as any;
  const rows: any[] = json?.data?.nations ?? [];
  const out: Record<number, NationDetail> = {};
  for (const r of rows) {
    const id = toNum(r?.id);
    if (!id) continue;
    out[id] = {
      id,
      name: str(r?.name, "Unknown"),
      score: toNumOrNull(r?.score),

      allianceId: toNumOrNull(r?.alliance?.id ?? r?.alliance_id),
      allianceName: strOrNull(r?.alliance?.name ?? r?.alliance_name),

      cities: toNumOrNull(r?.cities),

      offensiveWars: arrLen(r?.offensive_wars),
      defensiveWars: arrLen(r?.defensive_wars),

      lastActiveMinutes: toNumOrNull(r?.last_active_minutes),
      beigeTurns: toNumOrNull(r?.beige_turns),
      vmTurns: toNumOrNull(r?.vacation_mode_turns),

      soldiers: toNumOrNull(r?.soldiers),
      tanks: toNumOrNull(r?.tanks),
      aircraft: toNumOrNull(r?.aircraft),
      ships: toNumOrNull(r?.ships),
      missiles: toNumOrNull(r?.missiles),
      nukes: toNumOrNull(r?.nukes)
    };
  }
  return out;
}

// -------------------- REST fallback --------------------
async function tryREST(ids: number[]): Promise<Record<number, NationDetail>> {
  const out: Record<number, NationDetail> = {};
  for (const id of ids) {
    const url = `${REST}/nation/id=${id}&key=${encodeURIComponent(KEY)}`;
    const res = await fetch(url, { headers: { "Accept": "application/json" } }).catch(() => null);
    if (!res || !res.ok) continue;
    const json = await res.json().catch(() => null);
    if (!json) continue;

    const r = (json?.data && (Array.isArray(json.data) ? json.data[0] : json.data))
          || json?.nation || json;

    out[id] = {
      id,
      name: str(r?.name ?? r?.nation, "Unknown"),
      score: toNumOrNull(r?.score ?? r?.nation_score),

      allianceId: toNumOrNull(r?.alliance_id),
      allianceName: strOrNull(r?.alliance ?? r?.alliance_name),

      cities: toNumOrNull(r?.cities),

      offensiveWars: toNumOrNull(r?.offensive_wars ?? r?.offwar_count ?? r?.offensivewar_count),
      defensiveWars: toNumOrNull(r?.defensive_wars ?? r?.defwar_count ?? r?.defensivewar_count),

      lastActiveMinutes: toNumOrNull(r?.minutes_since_active ?? r?.last_active_minutes),
      beigeTurns: toNumOrNull(r?.beige_turns),
      vmTurns: toNumOrNull(r?.vm_turns ?? r?.vacation_mode_turns),

      soldiers: toNumOrNull(r?.soldiers),
      tanks: toNumOrNull(r?.tanks),
      aircraft: toNumOrNull(r?.aircraft),
      ships: toNumOrNull(r?.ships),
      missiles: toNumOrNull(r?.missiles),
      nukes: toNumOrNull(r?.nukes)
    };
  }
  return out;
}

// -------------------- utils --------------------
function toNum(v: any) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function toNumOrNull(v: any) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function str(v: any, fallback: string) { return (v === undefined || v === null) ? fallback : String(v); }
function strOrNull(v: any) { return (v === undefined || v === null) ? null : String(v); }
function arrLen(v: any) { return Array.isArray(v) ? v.length : toNumOrNull(v); }
