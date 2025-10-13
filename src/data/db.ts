import { Pool, type QueryResultRow } from "pg";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL missing");

export const pool = new Pool({ connectionString: url });

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: any[]
) {
  const res = await pool.query<T>(text, params);
  return res;
}
