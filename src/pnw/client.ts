// src/pnw/client.ts
// PNW client helpers for polling public bank records (nation deposits) and prices.
// Works with the GraphQL paginator shape you probed: bankrecs { data[] , paginatorInfo{} }.

type Json = any;

export type AidLike = {
  id: number;
  sentAt: string;
  senderId?: number | null;
  receiverId: number;
  senderName?: string | null;    // name fields not exposed in your schema; left undefined
  receiverName?: string | null;  // poller will resolve via fetchNationMap when needed
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
};

const GQL_BASE =
  (process.env.PNW_API_BASE_GRAPHQL || "https://api.politicsandwar.com/graphql").trim();

const API_KEY = (process.env.PNW_API_KEY || "").trim();

// GraphQL endpoint expects ?api_key=… (not header) for your key
function gqlUrl(): string {
  const sep = GQL_BASE.includes("?") ? "&" : "?";
  return `${GQL_BASE}${sep}api_key=${encodeURIComponent(API_KEY)}`;
}

async function gql<T = Json>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch(gqlUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json().catch(() => ({}))) as { data?: T; errors?: Json };
  if (!res.ok || json?.errors) {
    throw new Error(
      `GQL error (${res.status}): ${JSON.stringify(json?.errors || null)}`
    );
  }
  return (json.data ?? {}) as T;
}

// --- Prices (REST tradeprice endpoint) -----------------------------

const REST_BASE =
  (process.env.PNW_API_BASE_REST || "https://politicsandwar.com/api").replace(/\/+$/, "");

const RESOURCES = [
  "food",
  "munitions",
  "steel",
  "oil",
  "aluminum",
  "uranium",
  "gasoline",
  "coal",
  "iron",
  "bauxite",
  "lead",
] as const;

export async function fetchPriceMap(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  await Promise.all(
    RESOURCES.map(async (r) => {
      const url = `${REST_BASE}/tradeprice/?key=${encodeURIComponent(API_KEY)}&resource=${encodeURIComponent(
        r
      )}`;
      try {
        const resp = await fetch(url);
        const j = await resp.json().catch(() => ({}));
        const v = Number(j?.avgprice ?? 0);
        if (Number.isFinite(v)) out[r] = v;
      } catch {
        // ignore individual failures; return what we have
      }
    })
  );
  return out;
}

// --- Aid-like events from GraphQL bankrecs ------------------------

/**
 * Fetch newest bank records (nation deposits) and normalize to the "AidLike" shape
 * the poller expects. We only keep rows where receiver_type == 1 (nation).
 *
 * Stops when we hit (a) an id <= afterId, or (b) a date older than sinceIso.
 */
export async function fetchAidSince(
  afterId?: number,
  sinceIso?: string
): Promise<AidLike[]> {
  const first = 50;
  let page = 1;
  const rows: AidLike[] = [];
  const sinceTs = sinceIso ? Date.parse(sinceIso) : 0;

  // We page newest → older using ID DESC
  const QUERY = /* GraphQL */ `
    query BankPage($first: Int!, $page: Int!) {
      bankrecs(first: $first, page: $page, orderBy: [{ column: ID, order: DESC }]) {
        data {
          id
          date
          sender_type
          receiver_type
          sender { id }
          receiver { id }
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
        paginatorInfo { hasMorePages }
      }
    }
  `;

  while (true) {
    const data = await gql<{ bankrecs?: { data?: Json[]; paginatorInfo?: { hasMorePages?: boolean } } }>(
      QUERY,
      { first, page }
    );
    const list = data?.bankrecs?.data ?? [];
    if (!list.length) break;

    for (const r of list) {
      const idNum = Number(r.id);
      const ts = Date.parse(r.date);
      if (afterId && idNum <= afterId) return rows; // we've caught up
      if (sinceTs && ts < sinceTs) return rows;     // older than requested window
      if (Number(r.receiver_type) !== 1) continue;  // only nation→nation or AA→nation deposits

      const receiverId = r?.receiver?.id ? Number(r.receiver.id) : 0;
      const senderId = r?.sender?.id ? Number(r.sender.id) : undefined;

      const ev: AidLike = {
        id: idNum,
        sentAt: r.date,
        senderId,
        receiverId,
        senderName: undefined,
        receiverName: undefined,
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
      };

      rows.push(ev);
    }

    if (!data?.bankrecs?.paginatorInfo?.hasMorePages) break;
    page += 1;
    if (rows.length >= 500) break; // safety guard
  }

  return rows;
}
