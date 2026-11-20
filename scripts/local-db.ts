import { PGlite } from '@electric-sql/pglite';
import type { Database, Sql } from '../src/server/db.js';

/** PostgreSQL in-process for development/tests; hosted deployments always use pg. */
export function localDatabase(path?: string): Database {
  const pg = new PGlite(path);
  const adapt = (client: Pick<PGlite, 'query' | 'exec'>): Sql => ({
    query: (sql, params) =>
      params
        ? client.query(sql, params)
        : (client.exec(sql).then((results) => results.at(-1)!) as any),
  });
  return {
    ...adapt(pg),
    transaction: (fn) =>
      pg.transaction((tx) =>
        fn(adapt(tx as unknown as Pick<PGlite, 'query' | 'exec'>)),
      ),
    close: () => pg.close(),
  };
}
