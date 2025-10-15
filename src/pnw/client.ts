// src/pnw/client.ts
// PNW API client — uses GraphQL `bankrecs` (public bank records) and REST tradeprice.
// ESM-safe. Node 20+ has global fetch.

type PriceMap = Record<string, number>;

export type AidLike = {
  id: number;
  sentAt: string; // ISO
  // when sender/receiver are nations (type=1) we fill IDs; alliance/other types become undefined
  senderId?: number;
  senderName?: string;   // optional (we usually fill names via nations map elsewhere)
  receiverId?: number;
  receiverName?: string; // optional
  // values as numbers
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
  lead?: number; // not used in notional calc in v1, but we keep it
  note?: string | null;
};

const API_KEY = (process.env.PNW_API_KEY || "").trim();
const GQL_BASE =
  (process.env.PNW_API_BASE_GRAPHQL || "https://api.politicsandwar.com/graphql").trim();
const REST_BASE =
  (process.env.PNW_API_BASE_REST || "https://politicsandwar.com/api").trim();

function assertKey() {
  if (!API_KEY) {
    throw new Error("PNW_API_KEY is missing — set it in your environment.");
  }
}

async function gql<T = any>(query: string, variables?: Record<string, unknown>): Promise<T> {
  assertKey();
  const url = `${GQL_BASE}?api_key=${encodeURIComponent(API_KEY)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`GraphQL HTTP ${res.status}: ${await res.text()}`);
  }
  if (json?.errors?.length) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data as T;
}

/**
 * Fetch recent public bank records (all alliances/nations). This replaces the
 * old foreign-aid approach. We return a normalized “Aid-like” shape the rest
 * of the bot already expects.
 *
 * @param afterId  only return items with id > afterId (client-side filter)
 * @param sinceIso only return items with date > sinceIso (client-side filter)
 */
export async function fetchAidSince(
  afterId?: number,
  sinceIso?: string
): Promise<AidLike[]> {
  // We grab the latest page (server DESC), then client-filter and re-sort ASC.
  const q = `
    query LatestBankrecs {
      bankrecs(first: 50, orderBy: [{ column: ID, order: DESC }]) {
        data {
          id
          date
          sender_type
          sender_id
          receiver_type
          receiver_id
          sender { id }    # name is not exposed here
          receiver { id }  # name is not exposed here
          note
          money
          coal
          oil
          uranium
          iron
          bauxite
          lead
          gasoline
          munitions
          steel
          aluminum
          food
        }
      }
    }
  `;

  type GqlRow = {
    id: string;
    date: string;
    sender_type: number;   // 1 = nation, 2 = alliance (observed)
    sender_id: string | null;
    receiver_type: number; // 1 = nation, 2 = alliance (observed)
    receiver_id: string | null;
    sender?: { id: string } | null;
    receiver?: { id: string } | null;
    note?: string | null;
    money?: number | string | null;
    coal?: number | string | null;
    oil?: number | string | null;
    uranium?: number | string | null;
    iron?: number | string | null;
    bauxite?: number | string | null;
    lead?: number | string | null;
    gasoline?: number | string | null;
    munitions?: number | string | null;
    steel?: number | string | null;
    aluminum?: number | string | null;
    food?: number | string | null;
  };

  const d = await gql<{ bankrecs: { data: GqlRow[] } }>(q);
  const rows = d?.bankrecs?.data ?? [];

  const toNum = (v: unknown): number => (v == null ? 0 : Number(v) || 0);

  let out: AidLike[] = rows.map((r) => {
    const isSenderNation = r.sender_type === 1;
    const isReceiverNation = r.receiver_type === 1;
    const senderId =
      isSenderNation ? Number(r.sender?.id || r.sender_id || 0) || undefined : undefined;
    const receiverId =
      isReceiverNation ? Number(r.receiver?.id || r.receiver_id || 0) || undefined : undefined;

    return {
      id: Number(r.id),
      sentAt: r.date,
      senderId,
      receiverId,
      // Names are filled elsewhere (fetchNationMap) when building embeds.
      senderName: undefined,
      receiverName: undefined,
      cash: toNum(r.money),
      food: toNum(r.food),
      munitions: toNum(r.munitions),
      steel: toNum(r.steel),
      oil: toNum(r.oil),
      aluminum: toNum(r.aluminum),
      uranium: toNum(r.uranium),
      gasoline: toNum(r.gasoline),
      coal: toNum(r.coal),
      iron: toNum(r.iron),
      bauxite: toNum(r.bauxite),
      lead: toNum(r.lead),
      note: r.note ?? null,
    };
  });

  // Client-side filters to emulate the old cursor behavior
  if (afterId != null) {
    out = out.filter((r) => r.id > afterId);
  }
  if (sinceIso) {
    const cutoff = Date.parse(sinceIso);
    if (!Number.isNaN(cutoff)) {
      out = out.filter((r) => Date.parse(r.sentAt) > cutoff);
    }
  }

  // Old pipeline expects oldest→newest
  out.sort((a, b) => a.id - b.id);
  return out;
}

/**
 * Fetch a simple price map using the REST tradeprice endpoint for each resource.
 * Returns average prices keyed by resource name.
 */
export async function fetchPriceMap(): Promise<PriceMap> {
  assertKey();
  const resNames = [
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
    "lead", // not used in v1 notional but included for completeness
  ];

  const out: PriceMap = {};
  await Promise.all(
    resNames.map(async (name) => {
      const url = `${REST_BASE}/tradeprice/?key=${encodeURIComponent(API_KEY)}&resource=${encodeURIComponent(
        name
      )}`;
      try {
        const resp = await fetch(url, { headers: { accept: "application/json" } });
        const json = (await resp.json().catch(() => ({}))) as any;
        // API returns: { resource: "steel", avgprice: "7321", ... } or { success:false, general_message:"..." }
        const avg = Number(json?.avgprice ?? 0) || 0;
        out[name] = avg;
      } catch {
        out[name] = 0;
      }
    })
  );

  return out;
}
