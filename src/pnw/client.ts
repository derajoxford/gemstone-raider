// Minimal PnW client (GraphQL-first, REST fallback) + price map stub.

export type AidEvent = {
  id: number;
  sentAt: string;
  senderId: number | null;
  senderName: string | null;
  receiverId: number;
  receiverName: string;
  cash: number;
  food?: number; munitions?: number; steel?: number; oil?: number; aluminum?: number;
  uranium?: number; gasoline?: number; coal?: number; iron?: number; bauxite?: number;
};

const GQL = process.env.PNW_API_BASE_GRAPHQL || "https://api.politicsandwar.com/graphql";
const REST = process.env.PNW_API_BASE_REST || "https://politicsandwar.com/api";
const KEY  = process.env.PNW_API_KEY || "";

// Public API
export async function fetchAidSince(lastAidId?: number, sinceIso?: string): Promise<AidEvent[]> {
  if (!KEY) return [];
  const viaGraphQL = await tryGraphQL(lastAidId, sinceIso).catch(() => null);
  if (viaGraphQL && viaGraphQL.length) return viaGraphQL;
  const viaRest = await tryREST(lastAidId, sinceIso).catch(() => null);
  return viaRest ?? [];
}

async function tryGraphQL(lastAidId?: number, sinceIso?: string): Promise<AidEvent[]> {
  const q = /* GraphQL */ `
    query Aid($afterId: Int, $since: DateTime) {
      foreignAid(afterId: $afterId, since: $since, limit: 50, order: DESC) {
        id
        date
        sender { id name }
        receiver { id name }
        cash
        food
        munitions
        steel
        oil
        aluminum
        uranium
        gasoline
        coal
        iron
        bauxite
      }
    }
  `;
  const body = JSON.stringify({ query: q, variables: { afterId: lastAidId ?? null, since: sinceIso ?? null } });
  const res = await fetch(GQL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": KEY },
    body
  });
  if (!res.ok) throw new Error("GraphQL fetch failed: " + res.status);
  const json = await res.json() as any;
  const rows: any[] = json?.data?.foreignAid ?? [];
  return rows.map(toAidEvent);
}

async function tryREST(lastAidId?: number, sinceIso?: string): Promise<AidEvent[]> {
  const params = new URLSearchParams();
  params.set("key", KEY);
  if (lastAidId) params.set("min_id", String(lastAidId + 1));
  if (sinceIso) params.set("since", sinceIso);
  const url = `${REST}/foreignaid?${params.toString()}`;
  const res = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!res.ok) throw new Error("REST fetch failed: " + res.status);
  const json = await res.json() as any;
  const rows: any[] = json?.data ?? json?.foreignaid ?? json ?? [];
  return rows.map(toAidEvent);
}

function toAidEvent(r: any): AidEvent {
  const s = r.sender || r.donor || {};
  const t = r.receiver || r.recipient || {};
  return {
    id: Number(r.id ?? r.aidid ?? 0),
    sent
