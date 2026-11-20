import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createApp } from './app.js';
import { postgres, migrate } from './db.js';
import { validPasswordHash } from './auth.js';
import { renormalizeAnswerKeys } from './answers/bank.js';

const production = process.env.NODE_ENV === 'production';
const origin = process.env.APP_ORIGIN ?? 'http://localhost:3000';
if (production && new URL(origin).protocol !== 'https:')
  throw new Error('APP_ORIGIN must use HTTPS in production');
if (new URL(origin).origin !== origin)
  throw new Error(
    'APP_ORIGIN must be an origin without a path or trailing slash',
  );
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const db = postgres(process.env.DATABASE_URL);
await migrate(db);
// Idempotent data step: answer keys follow the current normalizeQuestion (no-op once applied).
await renormalizeAnswerKeys(db);
const email = process.env.PILOT_EMAIL?.toLowerCase(),
  passwordHash = process.env.PILOT_PASSWORD_HASH;
if (email && passwordHash) {
  if (!validPasswordHash(passwordHash))
    throw new Error('Invalid PILOT_PASSWORD_HASH');
  // Updating the configured password invalidates all existing sessions atomically.
  await db.transaction(async (sql) => {
    const current = (
      await sql.query(
        'SELECT id,password_hash FROM applicants WHERE email=$1 FOR UPDATE',
        [email],
      )
    ).rows[0];
    if (current && current.password_hash !== passwordHash)
      await sql.query('DELETE FROM sessions WHERE applicant_id=$1', [
        current.id,
      ]);
    await sql.query(
      'INSERT INTO applicants (id,email,password_hash) VALUES ($1,$2,$3) ON CONFLICT (email) DO UPDATE SET password_hash=EXCLUDED.password_hash',
      [randomUUID(), email, passwordHash],
    );
  });
} else if (!(await db.query('SELECT id FROM applicants LIMIT 1')).rows.length) {
  throw new Error(
    'Set PILOT_EMAIL and PILOT_PASSWORD_HASH before first startup',
  );
}
const app = await createApp(db, {
  production,
  origin,
  staticRoot: resolve('dist/web'),
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, async () => {
    await app.close();
    await db.close();
    process.exit(0);
  });
await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 3000) });
console.log('Jobapply listening');
