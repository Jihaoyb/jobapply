import { randomUUID } from 'node:crypto';
import { hashPassword } from '../src/server/auth.js';
import { migrate } from '../src/server/db.js';
import { localDatabase } from '../scripts/local-db.js';
import { createApp } from '../src/server/app.js';

export const origin = 'http://localhost:3000';
export const password = 'test-password-for-pilot';
const passwordHash = hashPassword(password);
export async function fixture() {
  const db = localDatabase();
  await migrate(db);
  await migrate(db); // A restart must preserve records and not rerun schema DDL.
  const alice = randomUUID(),
    bob = randomUUID();
  await db.query(
    'INSERT INTO applicants (id,email,password_hash) VALUES ($1,$2,$3),($4,$5,$3)',
    [alice, 'alice@example.com', passwordHash, bob, 'bob@example.com'],
  );
  const app = await createApp(db, { origin, production: false });
  async function login(email = 'alice@example.com') {
    const response = await app.inject({
      method: 'POST',
      url: '/api/login',
      headers: { origin },
      payload: { email, password },
    });
    if (response.statusCode !== 200) throw new Error(response.body);
    return response.cookies[0].name + '=' + response.cookies[0].value;
  }
  const cookie = await login();
  return {
    app,
    db,
    alice,
    bob,
    cookie,
    login,
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}
export function capture() {
  return {
    clientCaptureId: randomUUID(),
    title: 'Software Engineer',
    employer: 'Example Employer',
    discoveryUrl: 'https://www.linkedin.com/jobs/view/123',
    applicationUrl: 'https://boards.greenhouse.io/example/jobs/456',
    postingText: 'Build reliable software. Remote within the United States.',
  };
}
