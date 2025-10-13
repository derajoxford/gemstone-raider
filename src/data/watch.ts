import { query } from "./db.js";

export type WatchRow = {
  discord_user_id: string;
  nation_id: number;
  dm_enabled: boolean;
  bank_abs_usd: number | null;
  bank_rel_pct: number | null;
  beige_early_min: number | null;
  inrange_only: boolean;
};

export async function addOrUpdateWatch(
  uid: string,
  nationId: number,
  opts: Partial<Pick<WatchRow, "dm_enabled"|"bank_abs_usd"|"bank_rel_pct"|"beige_early_min"|"inrange_only">> = {}
) {
  const { dm_enabled = true, bank_abs_usd = null, bank_rel_pct = null, beige_early_min = null, inrange_only = false } = opts;
  await query(
    `INSERT INTO watchlist (discord_user_id, nation_id, dm_enabled, bank_abs_usd, bank_rel_pct, beige_early_min, inrange_only)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (discord_user_id, nation_id)
     DO UPDATE SET
       dm_enabled = COALESCE(EXCLUDED.dm_enabled, watchlist.dm_enabled),
       bank_abs_usd = COALESCE(EXCLUDED.bank_abs_usd, watchlist.bank_abs_usd),
       bank_rel_pct = COALESCE(EXCLUDED.bank_rel_pct, watchlist.bank_rel_pct),
       beige_early_min = COALESCE(EXCLUDED.beige_early_min, watchlist.beige_early_min),
       inrange_only = COALESCE(EXCLUDED.inrange_only, watchlist.inrange_only),
       updated_at = now()`,
    [uid, nationId, dm_enabled, bank_abs_usd, bank_rel_pct, beige_early_min, inrange_only]
  );
}

export async function removeWatch(uid: string, nationId: number) {
  await query(`DELETE FROM watchlist WHERE discord_user_id=$1 AND nation_id=$2`, [uid, nationId]);
}

export async function listWatches(uid: string) {
  const { rows } = await query<WatchRow>(
    `SELECT discord_user_id, nation_id, dm_enabled, bank_abs_usd, bank_rel_pct, beige_early_min, inrange_only
     FROM watchlist WHERE discord_user_id=$1 ORDER BY nation_id ASC`,
    [uid]
  );
  return rows;
}

export async function watchersForNation(nationId: number) {
  const { rows } = await query<WatchRow>(
    `SELECT discord_user_id, nation_id, dm_enabled, bank_abs_usd, bank_rel_pct, beige_early_min, inrange_only
     FROM watchlist WHERE nation_id=$1 AND dm_enabled=true`,
    [nationId]
  );
  return rows;
}
