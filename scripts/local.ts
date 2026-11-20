import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { localDatabase } from './local-db.js';
import { migrate } from '../src/server/db.js';
import { validPasswordHash } from '../src/server/auth.js';
import { createApp } from '../src/server/app.js';

if (process.env.NODE_ENV === 'production')
  throw new Error('Use PostgreSQL and npm start in production');
const email = process.env.PILOT_EMAIL?.toLowerCase(),
  passwordHash = process.env.PILOT_PASSWORD_HASH;
if (!email || !passwordHash || !validPasswordHash(passwordHash))
  throw new Error('Set PILOT_EMAIL and PILOT_PASSWORD_HASH in .env first');
const origin = process.env.APP_ORIGIN ?? 'http://localhost:3000';
if (
  new URL(origin).origin !== origin ||
  !['localhost', '127.0.0.1'].includes(new URL(origin).hostname)
)
  throw new Error('Local preview needs a localhost APP_ORIGIN');
const db = localDatabase(process.env.LOCAL_DATABASE_PATH ?? '.data/postgres');
await migrate(db);
await db.transaction(async (sql) => {
  const old = (
    await sql.query('SELECT id,password_hash FROM applicants WHERE email=$1', [
      email,
    ])
  ).rows[0];
  if (old && old.password_hash !== passwordHash)
    await sql.query('DELETE FROM sessions WHERE applicant_id=$1', [old.id]);
  await sql.query(
    'INSERT INTO applicants (id,email,password_hash) VALUES ($1,$2,$3) ON CONFLICT (email) DO UPDATE SET password_hash=EXCLUDED.password_hash',
    [randomUUID(), email, passwordHash],
  );
});
const app = await createApp(db, {
  production: false,
  origin,
  staticRoot: resolve('dist/web'),
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, async () => {
    await app.close();
    await db.close();
    process.exit(0);
  });
await app.listen({
  host: '127.0.0.1',
  port: Number(new URL(origin).port || 3000),
});
console.log(`Local dashboard: ${origin}`);
