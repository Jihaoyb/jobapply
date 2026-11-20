/**
 * Human-run live checks for lane D (never run by tests). Reads server env only.
 *   node --env-file-if-exists=.env --import tsx src/server/outreach/verify-cli.ts apollo
 *   node --env-file-if-exists=.env --import tsx src/server/outreach/verify-cli.ts smtp
 *   node --env-file-if-exists=.env --import tsx src/server/outreach/verify-cli.ts search <domain>
 *   node --env-file-if-exists=.env --import tsx src/server/outreach/verify-cli.ts enrich <apollo-person-id>
 *   node --env-file-if-exists=.env --import tsx src/server/outreach/verify-cli.ts send-self
 */
import { httpApollo } from './apollo.js';
import { gmailSmtp } from './smtp.js';

const [command, arg] = process.argv.slice(2);
const apollo = httpApollo(process.env.APOLLO_API_KEY || undefined);
const smtp = gmailSmtp({
  host: process.env.GMAIL_SMTP_HOST ?? 'smtp.gmail.com',
  port: Number(process.env.GMAIL_SMTP_PORT ?? 465),
  user: process.env.GMAIL_SMTP_USER || undefined,
  appPassword: process.env.GMAIL_APP_PASSWORD || undefined,
  timeoutMs: Number(process.env.GMAIL_SMTP_TIMEOUT_MS ?? 30_000),
});
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));

if (command === 'apollo') print(await apollo.verify());
else if (command === 'smtp') print(await smtp.verify());
else if (command === 'search' && arg)
  // Search does not reveal emails; prints only names/titles to pick one person for `enrich`.
  print(
    (
      await apollo.searchPeople({
        domain: arg,
        titles: ['recruiter', 'engineering manager'],
        perPage: 5,
      })
    ).map((p) => ({ id: p.id, name: p.name, title: p.title })),
  );
else if (command === 'enrich' && arg)
  // Exactly one people_match call; personal email, phone and waterfall stay disabled.
  print(
    await apollo.matchPerson({ id: arg } as Parameters<
      typeof apollo.matchPerson
    >[0]),
  );
else if (command === 'send-self') {
  if (!smtp.from) throw new Error('GMAIL_SMTP_USER is not set');
  print(
    await smtp.send({
      to: smtp.from,
      subject: 'Jobapply SMTP test to self',
      body: 'This is the lane D live check. No recruiter received this message.',
    }),
  );
} else {
  console.error(
    'Usage: verify-cli.ts apollo | smtp | search <domain> | enrich <person-id> | send-self',
  );
  process.exitCode = 2;
}
