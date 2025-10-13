// Lightweight nation fetcher (GraphQL-first, REST fallback).
// We only need: id, name, score. Everything else can come later.

export type NationLite = { id: number; name: string; score: number };

const GQL = process.env.PNW_API_BASE_GRAPHQL || "https://api.politicsandwar.com/graphql";
const REST = process.env.PNW_API_BASE_REST || "https://politicsandwar.com/api";
const KEY  = process.env.PNW_API_KEY || "";

// Public API
export async function fetchNationMap(ids: number[]): Promise<Record<number, NationLite>> {
  if (!ids.length || !KEY) return {};
  // de-dupe/sanitize
  const uniq = [...new Set(ids.map(n => Number(n)).filter(n => Number.isFinite(n) && n > 0))];
  if (!uniq.length) return {};

  // try GQL first
  const viaGql = await tryGraphQL(uniq).catch(() => null);
  if (viaGql && Object.keys(viaGql).length) return viaGql;

  // fallback to REST
  const viaRest = await tryREST(uniq).catch(() => null);
  return viaRest ?? {};
}

// -------------------- GraphQL attempt --------------------
async function tryGraphQL(ids: number[]): Promise<Record<number, NationLite>> {
  // Schema names can vary across deployments; we keep it minimal.
  const q = /* GraphQL */ `
    query Nations($ids: [Int!]!) {
      nations(ids: $ids) {
        id
        name
        score
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
  const out: Record<number, NationLite> = {};
  for (const r of rows) {
    const id = Number(r?.id);
    const score = Number(r?.score ?? 0);
    if (!Number.isFinite(id) || id <= 0) continue;
    out[id] = { id, name: String(r?.name ?? "Unknown"), score: Number.isFinite(score) ? score : 0 };
  }
  return out;
}

// -------------------- REST fallback --------------------
async function tryREST(ids: number[]): Promise<Record<number, NationLite>> {
  // Many community mirrors expose /nations with ?id=… or ?ids=…
  // We'll try a simple loop to avoid schema differences.
  const out: Record<number, NationLite> = {};
  for (const id of ids) {
    const url = `${REST}/nation/id=${id}&key=${encodeURIComponent(KEY)}`;
    const res = await fetch(url, { headers: { "Accept": "application/json" } }).catch(() => null);
    if (!res || !res.ok) continue;
    const json = await res.json().catch(() => null);
    if (!json) continue;

    // Try a few shapes
    const row = (json?.data && (Array.isArray(json.data) ? json.data[0] : json.data))
      || json?.nation || json;
    const score = Number(row?.score ?? row?.nation_score ?? 0);
    const name = String(row?.name ?? row?.nation ?? "Unknown");
    out[id] = { id, name, score: Number.isFinite(score) ? score : 0 };
  }
  return out;
}
