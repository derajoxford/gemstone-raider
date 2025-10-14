// src/pnw/client.ts
// PNW client utilities: GraphQL bankrecs + REST prices

type PriceMap = Record<string, number>;

export interface AidLikeEvent {
  id: number;
  sentAt: string; // ISO
  senderId?: number;
  receiverId: number;
  senderName?: string | null;
  receiverName?: string | null;
  // cash + resources (names match the rest of the codebase)
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
  lead: number;
}

const GQL_BASE = (process.env.PNW_API_BASE_GRAPHQL || "https://api.politicsandwar.com/graphql").replace(/\/*$/, "");
const REST_BASE = (process.env.PNW_API_BASE_REST || "https://politicsandwar.com/api").replace(/\/*$/, "");
const API_KEY  = process.env.PNW_API_KEY || process.env.PNW_SERVICE_API_KEY || "";

// --- low-level fetch helpers ---

async function gql<T = any>(query: string, variables?: Record<string, any>): Promise<T> {
  if (!API_KEY) throw new Error("Missing PNW_API_KEY");
  const url = `${GQL_BASE}?api_key=${encodeURIComponent(API_KEY)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables })
  });
  const json = await res.json();
  if (json.errors?.length) {
    const msg = json.errors.map((e: any) => e.message).join("; ");
    throw new Error(`GraphQL error: ${msg}`);
  }
  return json.data as T;
}

async function rest<T = any>(path: string, params: Record<string, string> = {}): Promise<T> {
  if (!API_KEY) throw new Error("Missing PNW_API_KEY");
  const u = new URL(`${REST_BASE}/${path.replace(/^\//, "")}`);
  u.searchParams.set("key", API_KEY);
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
  const res = await fetch(u, { headers: { accept: "application/json" } });
  // tradeprice returns 200 with JSON body; invalid key yields { success:false, general_message:"..." }
  const json = await res.json().catch(() => ({}));
  if (json && json.success === false) {
    throw new Error(`REST error for ${u.pathname}: ${json.general_message || "unknown"}`);
  }
  return json as T;
}

// --- prices ---

const RESOURCE_KEYS = [
  "food","munitions","steel","oil","aluminum",
  "uranium","gasoline","coal","iron","bauxite","lead"
] as const;

export async function fetchPriceMap(): Promise<PriceMap> {
  const map: PriceMap = {};
  for (const r of RESOURCE_KEYS) {
    try {
      // /api/tradeprice/?key=...&resource=steel
      const data: any = await rest(`tradeprice/`, { resource: r });
      // avgprice is a string number
      const p = Number(data?.avgprice ?? 0);
      map[r] = Number.isFinite(p) ? p : 0;
    } catch {
      map[r] = 0;
    }
  }
  return map;
}

// --- bankrecs → AidLikeEvent ---

type BankrecRow = {
  id: string;
  date: string;
  sender_type?: number;
  sender_id?: string;
  sender?: string | null;
  receiver_type?: number;
  receiver_id?: string;
  receiver?: string | null;
  note?: string | null;
  money?: number;
  coal?: number; oil?: number; uranium?: number; iron?: number; bauxite?: number; lead?: number;
  gasoline?: number; munitions?: number; steel?: number; aluminum?: number; food?: number;
};

function mapBankrecToAidLike(b: BankrecRow): AidLikeEvent {
  return {
    id: Number(b.id),
    sentAt: b.date,
    senderId: b.sender_id ? Number(b.sender_id) : undefined,
    receiverId: b.receiver_id ? Number(b.receiver_id) : 0,
    senderName: b.sender ?? null,
    receiverName: b.receiver ?? null,
    cash: Number(b.money ?? 0),
    food: Number(b.food ?? 0),
    munitions: Number(b.munitions ?? 0),
    steel: Number(b.steel ?? 0),
    oil: Number(b.oil ?? 0),
    aluminum: Number(b.aluminum ?? 0),
    uranium: Number(b.uranium ?? 0),
    gasoline: Number(b.gasoline ?? 0),
    coal: Number(b.coal ?? 0),
    iron: Number(b.iron ?? 0),
    bauxite: Number(b.bauxite ?? 0),
    lead: Number(b.lead ?? 0),
  };
}

/**
 * Replacement for old fetchAidSince: we now read from bankrecs.
 * - We always pull the most recent N and filter client-side using lastId/since.
 * - We only keep deposits TO nations (receiver_type === 1).
 * - Returns ascending by id so the poller can process oldest → newest.
 */
export async function fetchAidSince(lastId?: number, sinceIso?: string, first: number = 100): Promise<AidLikeEvent[]> {
  // orderBy on ID DESC works (you proved this on trades; bankrecs uses same paginator style)
  const query = `
    query Bank($first:Int!){
      bankrecs(first:$first, orderBy:[{ column: ID, order: DESC }]) {
        data {
          id date sender_type sender_id sender
          receiver_type receiver_id receiver
          note money coal oil uranium iron bauxite lead gasoline munitions steel aluminum food
        }
      }
    }
  `;
  const data = await gql<{ bankrecs: { data: BankrecRow[] } }>(query, { first });
  const rows = data?.bankrecs?.data ?? [];

  const filtered = rows
    // only records where the receiver is a nation (type 1)
    .filter(r => Number(r.receiver_type) === 1)
    // cursor filters
    .filter(r => (lastId ? Number(r.id) > lastId : true))
    .filter(r => (sinceIso ? new Date(r.date).getTime() >= new Date(sinceIso).getTime() : true))
    .map(mapBankrecToAidLike)
    // return ascending by id for stable processing order
    .sort((a, b) => a.id - b.id);

  return filtered;
}
