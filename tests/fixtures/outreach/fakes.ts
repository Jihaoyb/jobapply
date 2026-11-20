import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  ApolloLimitError,
  ApolloNotConfiguredError,
  JOB_SEARCH_LABEL,
  type ApolloClient,
  type ApolloMatch,
  type ApolloPerson,
} from '../../../src/server/outreach/apollo.js';
import {
  SmtpTimeoutError,
  SmtpRejectedError,
  type OutgoingEmail,
  type SmtpSender,
} from '../../../src/server/outreach/smtp.js';

/** Synthetic people only: fake names at an example domain. */
export function syntheticPeople(
  organizationName = 'Northwind Example',
): ApolloPerson[] {
  const raw = JSON.parse(
    readFileSync(new URL('./people.json', import.meta.url), 'utf8'),
  ) as Array<{
    id: string;
    name: string;
    title: string;
    headline: string;
    departments: string[];
  }>;
  return raw.map((p) => {
    const [firstName, ...rest] = p.name.split(' ');
    return {
      id: p.id,
      name: p.name,
      firstName,
      lastName: rest.join(' '),
      title: p.title,
      organizationName,
      linkedinUrl: `https://www.linkedin.com/in/${p.id}`,
      headline: p.headline,
      seniority: null,
      departments: p.departments,
    };
  });
}

export interface FakeContact {
  id: string;
  personId: string | null;
  email: string | null;
  fields: Record<string, string>;
  labels: string[];
}
/** In-memory Apollo that counts every call so tests can assert "zero Apollo calls". */
export class FakeApollo implements ApolloClient {
  configured = true;
  calls = {
    verify: 0,
    enrichOrganization: 0,
    searchPeople: 0,
    matchPerson: 0,
    saveToJobSearch: 0,
  };
  people: ApolloPerson[] = syntheticPeople();
  organizations = new Map<string, string | null>();
  matched: string[] = [];
  searches: Array<{ domain: string; titles: string[]; perPage: number }> = [];
  matches = new Map<string, ApolloMatch>();
  contacts: FakeContact[] = [];
  fail: Partial<Record<keyof FakeApollo['calls'], Error>> = {};
  get total() {
    return Object.values(this.calls).reduce((a, b) => a + b, 0);
  }
  private guard(method: keyof FakeApollo['calls']) {
    this.calls[method]++;
    if (!this.configured) throw new ApolloNotConfiguredError();
    const error = this.fail[method];
    if (error) throw error;
  }
  async verify() {
    this.calls.verify++;
    return {
      ok: this.configured,
      checks: [{ name: 'key', ok: this.configured, detail: 'fake' }],
    };
  }
  async enrichOrganization(name: string) {
    this.guard('enrichOrganization');
    const domain = this.organizations.get(name) ?? null;
    return domain ? { name, domain, websiteUrl: `https://${domain}` } : null;
  }
  async searchPeople(input: {
    domain: string;
    titles: string[];
    perPage: number;
  }) {
    this.guard('searchPeople');
    this.searches.push(input);
    // Deliberately ignores perPage: the worker must enforce the input limit itself.
    return this.people;
  }
  async matchPerson(person: ApolloPerson) {
    this.guard('matchPerson');
    this.matched.push(person.id);
    return (
      this.matches.get(person.id) ?? {
        email: `${person.firstName.toLowerCase()}@northwind.example`,
        emailStatus: 'verified',
      }
    );
  }
  async saveToJobSearch(person: ApolloPerson, email: string | null) {
    this.guard('saveToJobSearch');
    const existing = this.contacts.find(
      (c) => c.personId === person.id || (email && c.email === email),
    );
    if (existing) {
      if (!existing.labels.includes(JOB_SEARCH_LABEL))
        existing.labels.push(JOB_SEARCH_LABEL);
      return { contactId: existing.id, created: false };
    }
    const contact: FakeContact = {
      id: `contact-${randomUUID()}`,
      personId: person.id,
      email,
      fields: { title: person.title },
      labels: [JOB_SEARCH_LABEL],
    };
    this.contacts.push(contact);
    return { contactId: contact.id, created: true };
  }
}
export const apolloLimit = () =>
  new ApolloLimitError(
    'Apollo limit reached (429) on /mixed_people/api_search',
  );

export type SmtpMode = 'accept' | 'timeout' | 'reject';
/** In-memory SMTP: each send consumes the next scripted mode (default accept). */
export class FakeSmtp implements SmtpSender {
  configured = true;
  from = 'applicant@example.com';
  sends: OutgoingEmail[] = [];
  modes: SmtpMode[] = [];
  verifies = 0;
  async verify() {
    this.verifies++;
    return {
      ok: this.configured,
      checks: [{ name: 'smtp_auth', ok: this.configured, detail: 'fake' }],
    };
  }
  async send(message: OutgoingEmail) {
    this.sends.push(message);
    const mode = this.modes.shift() ?? 'accept';
    if (mode === 'timeout')
      throw new SmtpTimeoutError('No SMTP reply after message data');
    if (mode === 'reject')
      throw new SmtpRejectedError('SMTP 550: rejected', 550);
    return { messageId: `<${randomUUID()}@example.com>`, response: '2.0.0 OK' };
  }
}

/** Fake OpenAI Responses transport behind the real model wrapper. */
export function fakeLuna() {
  const state = {
    requests: [] as any[],
    failNext: false,
    rankingPicks: null as string[] | null,
  };
  const transport = (async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    state.requests.push(body);
    if (state.failNext) {
      state.failNext = false;
      return new Response('{}', { status: 500 });
    }
    const input = JSON.parse(body.input);
    let output: unknown;
    if (input.task === 'contact_ranking') {
      const ids: string[] =
        state.rankingPicks ?? input.candidates.map((c: any) => c.personId);
      output = {
        recommendations: ids.slice(0, 3).map((personId, index) => ({
          personId,
          score: 5 - index,
          reason: `Synthetic reason ${index + 1}`,
          evidence:
            input.candidates.find((c: any) => c.personId === personId)?.title ??
            'title',
        })),
      };
    } else {
      output = {
        emailSubject: `Following up on ${input.job.title}`,
        emailBody: `Hi ${input.recipient.name.split(' ')[0]},\nI applied for ${input.job.title}.`,
        linkedinNote: `Hi ${input.recipient.name.split(' ')[0]}, I applied for ${input.job.title} and would value connecting.`,
      };
    }
    return Response.json({
      status: 'completed',
      model: body.model,
      usage: { input_tokens: 100, output_tokens: 50 },
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: JSON.stringify(output) }],
        },
      ],
    });
  }) as typeof fetch;
  return {
    state,
    transport,
    tasks: () => state.requests.map((r) => JSON.parse(r.input).task as string),
  };
}
