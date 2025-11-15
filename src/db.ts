// src/db.ts
import { Pool } from "pg";

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30_000,
});

// Optional: clean shutdown in tests/scripts; harmless in prod
process.on("beforeExit", async () => {
  try {
    await pool.end();
  } catch {
    // ignore
  }
});
