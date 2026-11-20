import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';

export interface Sql {
  query<T extends Record<string, any> = Record<string, any>>(
    sql: string,
    params?: any[],
  ): Promise<{ rows: T[] }>;
}
export interface Database extends Sql {
  transaction<T>(fn: (sql: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export function postgres(url: string): Database {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  return {
    query: (sql, params) => pool.query(sql, params),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
const migrationsDir = new URL('./migrations/', import.meta.url);
/** Applies migrations/NNN_name.sql in order; each version runs once. */
export async function migrate(db: Database) {
  const files = (await readdir(migrationsDir))
    .filter((file) => /^\d{3}_[a-z0-9_]+\.sql$/.test(file))
    .sort();
  await db.transaction(async (sql) => {
    // Serializes migrations across Railway replicas; all DDL runs atomically.
    await sql.query('SELECT pg_advisory_xact_lock(734881)');
    await sql.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY)',
    );
    const applied = new Set(
      (await sql.query('SELECT version FROM schema_migrations')).rows.map(
        (row) => Number(row.version),
      ),
    );
    for (const file of files) {
      const version = Number(file.slice(0, 3));
      if (applied.has(version)) continue;
      await sql.query(await readFile(new URL(file, migrationsDir), 'utf8'));
      await sql.query('INSERT INTO schema_migrations (version) VALUES ($1)', [
        version,
      ]);
    }
  });
}
