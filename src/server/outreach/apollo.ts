/**
 * Apollo boundary. The worker depends only on the `ApolloClient` interface so
 * tests use in-memory fakes; `httpApollo` is the production adapter.
 * Endpoint shapes follow https://docs.apollo.io and are confirmed by the
 * human-run live check in docs/p2/outreach.md.
 */
export interface ApolloPerson {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  title: string;
  organizationName: string;
  linkedinUrl: string | null;
  headline: string | null;
  seniority: string | null;
  departments: string[];
}
export interface ApolloOrganization {
  name: string;
  domain: string | null;
  websiteUrl: string | null;
}
export interface ApolloMatch {
  email: string | null;
  /** Apollo email status, e.g. `verified`, `guessed`, `unavailable`. */
  emailStatus: string | null;
}
export interface SetupCheck {
  name: string;
  ok: boolean;
  detail: string;
}
export interface SetupReport {
  ok: boolean;
  checks: SetupCheck[];
}
export interface ApolloClient {
  readonly configured: boolean;
  verify(): Promise<SetupReport>;
  /** Name-based organization lookup; proposes a domain for confirmation. */
  enrichOrganization(name: string): Promise<ApolloOrganization | null>;
  searchPeople(input: {
    domain: string;
    titles: string[];
    perPage: number;
  }): Promise<ApolloPerson[]>;
  /** people_match for one person: business email only, no phone/personal/waterfall. */
  matchPerson(person: ApolloPerson): Promise<ApolloMatch>;
  /** Saves (or updates) the contact and adds the Job Search label, preserving other fields and labels. */
  saveToJobSearch(
    person: ApolloPerson,
    email: string | null,
  ): Promise<{ contactId: string; created: boolean }>;
}

export class ApolloNotConfiguredError extends Error {
  constructor() {
    super('Apollo API key is not configured on the server');
  }
}
/** Rate limits, exhausted credits, or plan/endpoint access refusal. */
export class ApolloLimitError extends Error {}
export class ApolloRequestError extends Error {}

export const JOB_SEARCH_LABEL = 'Job Search';
export const MATCH_OPTIONS = {
  reveal_personal_emails: false,
  reveal_phone_number: false,
  run_waterfall_email: false,
  run_waterfall_phone: false,
} as const;

const BASE = 'https://api.apollo.io/api/v1';

export function httpApollo(
  apiKey: string | undefined,
  transport: typeof fetch = fetch,
): ApolloClient {
  async function call(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
  ): Promise<any> {
    if (!apiKey) throw new ApolloNotConfiguredError();
    let response: Response;
    try {
      response = await transport(`${BASE}${path}`, {
        method,
        signal: AbortSignal.timeout(30_000),
        headers: {
          'X-Api-Key': apiKey,
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApolloRequestError('Apollo request failed');
    }
    if (response.status === 429 || response.status === 402)
      throw new ApolloLimitError(
        `Apollo limit reached (${response.status}) on ${path}`,
      );
    if (response.status === 401 || response.status === 403)
      throw new ApolloLimitError(
        `Apollo refused access (${response.status}) to ${path}`,
      );
    const text = await response.text();
    if (!response.ok) {
      // Credit exhaustion is reported as a 422 with a credits message.
      if (/credit/i.test(text))
        throw new ApolloLimitError(`Apollo credits exhausted on ${path}`);
      throw new ApolloRequestError(
        `Apollo request failed (${response.status}) on ${path}`,
      );
    }
    return text ? JSON.parse(text) : {};
  }
  const toPerson = (p: any): ApolloPerson => ({
    id: String(p.id),
    name:
      p.name ?? [p.first_name, p.last_name ?? p.last_name_obfuscated].join(' '),
    firstName: p.first_name ?? '',
    lastName: p.last_name ?? p.last_name_obfuscated ?? '',
    title: p.title ?? '',
    organizationName: p.organization?.name ?? p.organization_name ?? '',
    linkedinUrl: p.linkedin_url ?? null,
    headline: p.headline ?? null,
    seniority: p.seniority ?? null,
    departments: Array.isArray(p.departments) ? p.departments : [],
  });
  let jobSearchLabelId: string | undefined;
  async function labelId() {
    if (jobSearchLabelId) return jobSearchLabelId;
    const labels: any[] = await call('GET', '/labels');
    const found = (Array.isArray(labels) ? labels : []).find(
      (label) =>
        label.name === JOB_SEARCH_LABEL &&
        (!label.modality || label.modality === 'contacts'),
    );
    jobSearchLabelId = found
      ? String(found.id)
      : String(
          (
            await call('POST', '/labels', {
              name: JOB_SEARCH_LABEL,
              modality: 'contacts',
            })
          ).id,
        );
    return jobSearchLabelId;
  }
  return {
    configured: Boolean(apiKey),
    async verify() {
      const checks: SetupCheck[] = [];
      if (!apiKey)
        return {
          ok: false,
          checks: [{ name: 'key', ok: false, detail: 'APOLLO_API_KEY unset' }],
        };
      const attempt = async (name: string, fn: () => Promise<string>) => {
        try {
          checks.push({ name, ok: true, detail: await fn() });
        } catch (error) {
          checks.push({ name, ok: false, detail: (error as Error).message });
        }
      };
      await attempt('key', async () => {
        const health = await call('GET', '/auth/health');
        if (!health.is_logged_in) throw new Error('Key not accepted');
        return 'Key accepted';
      });
      await attempt('people_search', async () => {
        await call('POST', '/mixed_people/api_search', {
          q_organization_domains_list: ['example.com'],
          per_page: 1,
        });
        return 'People search reachable';
      });
      await attempt('limits', async () => {
        const stats = await call('POST', '/usage_stats/api_usage_stats');
        const match = Object.entries(stats ?? {}).find(([key]) =>
          key.includes('people/match'),
        )?.[1] as any;
        const left = match?.day?.left_over;
        if (typeof left === 'number' && left <= 0)
          throw new Error('people_match daily limit exhausted');
        return `people_match left today: ${left ?? 'unknown'}`;
      });
      await attempt('credits', async () => {
        const profile = await call('GET', '/users/api_profile');
        const credits =
          profile?.user?.email_credits_remaining ??
          profile?.email_credits_remaining;
        if (typeof credits === 'number' && credits <= 0)
          throw new Error('No email credits remaining');
        return `Email credits remaining: ${credits ?? 'unknown (check Apollo settings)'}`;
      });
      return { ok: checks.every((check) => check.ok), checks };
    },
    async enrichOrganization(name) {
      const result = await call('POST', '/mixed_companies/search', {
        q_organization_name: name,
        per_page: 1,
      });
      const org = (result.organizations ?? result.accounts ?? [])[0];
      if (!org) return null;
      return {
        name: org.name ?? name,
        domain: org.primary_domain ?? null,
        websiteUrl: org.website_url ?? null,
      };
    },
    async searchPeople({ domain, titles, perPage }) {
      const result = await call('POST', '/mixed_people/api_search', {
        q_organization_domains_list: [domain],
        person_titles: titles,
        include_similar_titles: true,
        per_page: perPage,
        page: 1,
      });
      return (result.people ?? []).slice(0, perPage).map(toPerson);
    },
    async matchPerson(person) {
      const result = await call('POST', '/people/match', {
        id: person.id,
        ...MATCH_OPTIONS,
      });
      return {
        email: result.person?.email ?? null,
        emailStatus: result.person?.email_status ?? null,
      };
    },
    async saveToJobSearch(person, email) {
      const label = await labelId();
      const search = await call('POST', '/contacts/search', {
        q_keywords: email ?? person.name,
        per_page: 10,
      });
      const existing = (search.contacts ?? []).find(
        (contact: any) =>
          contact.person_id === person.id ||
          (email && contact.email?.toLowerCase() === email.toLowerCase()),
      );
      if (existing) {
        const labels: string[] = (existing.label_ids ?? []).map(String);
        // Send only label_ids so every other contact field stays untouched.
        if (!labels.includes(label))
          await call('PUT', `/contacts/${existing.id}`, {
            label_ids: [...labels, label],
          });
        return { contactId: String(existing.id), created: false };
      }
      const created = await call('POST', '/contacts', {
        first_name: person.firstName,
        last_name: person.lastName,
        title: person.title,
        organization_name: person.organizationName,
        email: email ?? undefined,
        linkedin_url: person.linkedinUrl ?? undefined,
        label_names: [JOB_SEARCH_LABEL],
        run_dedupe: true,
      });
      return { contactId: String(created.contact?.id), created: true };
    },
  };
}
