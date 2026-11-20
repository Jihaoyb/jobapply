/** Lane D dashboard view types (server → web). Contracts v1 is unchanged. */
export interface OutreachCandidateView {
  id: string;
  rank: number;
  name: string;
  title: string;
  organization: string;
  linkedinUrl: string | null;
  score: number;
  reason: string;
  evidence: string;
  priorContact: boolean;
  priorContactDetail: string | null;
  businessEmail: string | null;
  emailStatus: string | null;
}
export interface OutreachPosition {
  jobId: string;
  title: string;
  employer: string;
  jobStatus: string;
  worker: { outcome: string; detail: string } | null;
  ticket: {
    id: string;
    kind: 'employer' | 'domain' | 'provider' | 'review' | 'uncertain_email';
    question: string;
    choices: string[];
    proposedDomains: string[];
  } | null;
  shortlist: {
    id: string;
    domain: string;
    candidatesSent: number;
    candidates: OutreachCandidateView[];
  } | null;
  review: {
    status: 'drafting' | 'ready' | 'approved' | 'skipped' | 'closed';
    version: number;
    candidateId: string;
    emailSubject: string | null;
    emailBody: string | null;
    linkedinNote: string | null;
    draftError: string | null;
    outcome: string | null;
    linkedinRecordedAt: string | null;
  } | null;
  delivery: {
    id: string;
    status: 'pending' | 'sending' | 'accepted' | 'uncertain';
    toAddress: string;
    attempts: number;
    reconciled: boolean;
  } | null;
}
export interface OutreachView {
  positions: OutreachPosition[];
}
