// src/pnw/client.ts
// Minimal PNW client for the Raider bot using GraphQL `bankrecs` and REST prices.

type Json = Record<string, any>;

const GQL_BASE = (process.env.PNW_API_BASE_GRAPHQL || "https://api.politicsandwar.com/graphql").replace(/\/+$/, "");
const REST_BASE = (process.env.PNW_API_BASE_REST || "https://politicsandwar.com/api").replace(/\/+$/, "");
const API_KEY   = process.env.PNW_API_KEY || "";

if (!API_KEY) {
  // Don't throw here — callers will see empty results, but we log loudly.
  // Service env must provide PNW_API_KEY.
  console.error("[pnw/client] WARNING: PNW_API_KEY is empty.");
}

/** POST a GraphQL query; api_key goes in the query string (required by PNW). */
async function postGraphQL<T>(query: string, variables?: Json): Promise<T> {
  const url = `${GQL_BASE}?api_key=${encodeURIComponent(API_KEY)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`[pnw/client] GraphQL HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  const body = await res.json().catch(() => ({} as any));
  if (body.errors?.length) {
    const msg = body.errors.map((e: any) => e.message).join("; ");
    throw new Error(`[pnw/client] GraphQL error(s): ${msg}`);
  }
  return body.data as T;
}

/** Fetch average market prices for resources via REST tradeprice endpoint. */
export async function fetchPriceMap(): Promise<Record<string, number>> {
  const resources = [
    "food", "munitions", "steel", "oil", "aluminum", "uranium",
    "gasoline", "coal", "iron", "bauxite", "lead",
  ];
  const out: Record<string, number> = {};
  for (const r of resources) {
    try {
      const url = `${REST_BASE}/tradeprice/?key=${encodeURIComponent(API_KEY)}&resource=${encodeURIComponent(r)}`;
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (!res.ok) continue;
      const j = await res.json();
      const n = Number(String(j?.avgprice ?? "0").replace(/,/g, ""));
      if (Number.isFinite(n) && n > 0) out[r] = n;
    } catch {
      // ignore single-resource failures
    }
  }
  return out;
}

/** Normalized row the rest of the bot expects (historically from 'aid'). */
export type AidLikeRow = {
  id: number;
  sentAt: string;
  senderId?: number | null;
  senderName?: string | null;
  receiverId: number;
  receiverName: string;
  // amounts in native units; 'cash' is money
  cash: number;
  food: number;
  munitions: number;
  steel: number;
  oil: number;
  aluminum: number;
  uranium: number;
  gasoline: number;
  coal: number;
  iron: number;
  bauxite: number;
  // lead exists on Bankrec but we don't currently price it in alerts
  lead?: number;
  note?: string | null;
};

/**
 * Back-compat function name: fetchAidSince
 * Internally reads the Bankrec paginator, newest-first (by ID desc),
 * then we client-filter by (lastId, sinceIso) if provided.
 *
 * NOTE: Some Bankrec rows (e.g., war loot) are still legitimate nation
 *       deposits from our perspective; we don't filter them out here.
 */
export async function fetchAidSince(lastId?: number, sinceIso?: string): Promise<AidLikeRow[]> {
  // Ask for the latest N rows; we’ll filter locally against lastId/sinceIso.
  const LIMIT = 50;

  const QUERY = /* GraphQL */ `
    query LatestBankrecs($first: Int!) {
      bankrecs(first: $first, orderBy: [{ column: ID, order: DESC }]) {
        data {
          id
          date
          sender_type
          receiver_type
          sender { id name }
          receiver { id name }
          note
          money
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
          lead
        }
      }
    }
  `;

  type GqlRow = {
    id: string;
    date: string;
    sender_type: number;
    receiver_type: number;
    sender: { id: string; name: string } | null;
    receiver: { id: string; name: string } | null;
    note?: string | null;
    money?: number;
    food?: number;
    munitions?: number;
    steel?: number;
    oil?: number;
    aluminum?: number;
    uranium?: number;
    gasoline?: number;
    coal?: number;
    iron?: number;
    bauxite?: number;
    lead?: number;
  };

  const data = await postGraphQL<{ bankrecs: { data: GqlRow[] } }>(QUERY, { first: LIMIT });
  const rows = data?.bankrecs?.data ?? [];

  const sinceMs = sinceIso ? Date.parse(sinceIso) : undefined;

  // Normalize to the 'aid-like' shape the rest of the bot already uses.
  const mapped: AidLikeRow[] = rows.map((r) => ({
    id: Number(r.id),
    sentAt: r.date,
    senderId: r.sender ? Number(r.sender.id) : null,
    senderName: r.sender?.name ?? null,
    receiverId: r.receiver ? Number(r.receiver.id) : 0,
    receiverName: r.receiver?.name ?? "Unknown",
    cash: Number(r.money ?? 0),
    food: Number(r.food ?? 0),
    munitions: Number(r.munitions ?? 0),
    steel: Number(r.steel ?? 0),
    oil: Number(r.oil ?? 0),
    aluminum: Number(r.aluminum ?? 0),
    uranium: Number(r.uranium ?? 0),
    gasoline: Number(r.gasoline ?? 0),
    coal: Number(r.coal ?? 0),
    iron: Number(r.iron ?? 0),
    bauxite: Number(r.bauxite ?? 0),
    lead: Number(r.lead ?? 0),
    note: r.note ?? null,
  }));

  // Client-side filter using lastId / sinceIso if given.
  const filtered = mapped.filter((m) => {
    if (lastId && m.id <= lastId) return false;
    if (sinceMs && Date.parse(m.sentAt) <= sinceMs) return false;
    return true;
  });

  return filtered;
}
