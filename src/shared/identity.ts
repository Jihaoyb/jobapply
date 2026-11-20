/** Lane A (issues 002-004) request schemas and response shapes; contracts v1 is untouched. */
import { z } from 'zod';

const uuid = z.uuid();
export const identityResolution = z.discriminatedUnion('action', [
  z.object({ action: z.literal('assign'), employerId: uuid }),
  z.object({ action: z.literal('merge'), employerId: uuid }),
  z.object({
    action: z.literal('create'),
    name: z.string().trim().min(1).max(300).optional(),
  }),
]);
export type IdentityResolution = z.infer<typeof identityResolution>;

export const aliasInput = z.object({
  key: z.string().trim().min(3).max(200),
  employerId: uuid,
});
export const mergeInput = z.object({ intoEmployerId: uuid });
export const distinctInput = z.object({ otherEmployerId: uuid });
export const employerPatch = z
  .object({
    name: z.string().trim().min(1).max(300).optional(),
    domain: z.string().trim().max(253).nullable().optional(),
  })
  .refine((value) => value.name !== undefined || value.domain !== undefined, {
    message: 'Provide a name or domain',
  });
export const importInput = z.object({
  filename: z.string().trim().max(200).default('history.csv'),
  csv: z.string().min(1).max(900_000),
});
export const capSettingsInput = z.object({
  limit: z.number().int().min(1).max(50),
  windowMonths: z.number().int().min(1).max(24),
});

export interface EmployerView {
  id: string;
  name: string;
  /** Nullable company domain; shared-ATS-only employers may leave it empty for issue 010. */
  domain: string | null;
  aliases: {
    id: string;
    key: string;
    kind: 'domain' | 'ats';
    source: string;
  }[];
  links: {
    domainKey: string;
    atsKey: string;
    relation: 'redirect' | 'embed';
    careersUrl: string;
    atsUrl: string;
    status: 'linked' | 'conflict' | 'resolved';
  }[];
  mergedFrom: string[];
  cap: {
    count: number;
    limit: number;
    capped: boolean;
    windowStart: string;
    nextAvailableDate: string;
    heldBy: string[];
  };
}
export interface MergeSuggestionView {
  employerIds: [string, string];
  names: [string, string];
  reason: string;
}
export interface QueueItemView {
  jobId: string;
  title: string;
  employer: string;
  jobStatus: string;
  state: 'queued' | 'active' | 'paused' | 'done' | 'stopped';
  holdReason: string | null;
  stopReason: string | null;
  nextAvailableDate: string | null;
}
