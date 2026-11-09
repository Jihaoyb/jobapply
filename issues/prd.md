# Job application and outreach pilot

## Problem Statement

As an applicant on F-1 OPT, I find the same position on job boards and employer sites. Each application makes me check work-authorization requirements, remember where I have already applied, and answer questions I may have answered elsewhere. After submitting, I need to identify someone who can speak to the role and remember whom I contacted. I want one decision per position and a reliable record of what the employer received and whom I contacted.

## Solution

A Chrome extension lets me select **Yes** or **No** while viewing a posting. Yes records the job and starts the eligibility and application workflow. No dismisses it. During the pilot, one active tab handles Greenhouse, Lever, and Ashby applications in my signed-in browser session. A private hosted dashboard shows my application history, answers, documents, and tickets that need my attention.

Only a confirmed submission starts contact research. I review one recommended recipient, one email, and one LinkedIn note per position. Seven days after my first live decision, the dashboard shows where applications stopped, what needed correction, and which improvement would save the most effort.

## User Stories

1. As an applicant, I want to choose a job on LinkedIn, Indeed, ZipRecruiter, or an employer site, so that I can start where I found it.
2. As an applicant, I want repeat sightings linked to the same requisition, so that a second discovery route cannot trigger a second application.
3. As an applicant, I want to merge employer aliases and import earlier applications, so that the cap reflects my actual history.
4. As an applicant, I want to see when a capped employer becomes available again, so that I know when to revisit a position.
5. As an applicant, I want an exact quote for an eligibility exclusion, so that I can verify why the job was screened out.
6. As an applicant, I want to review unclear restrictions before submission, so that my current authorization and future sponsorship needs are represented accurately.
7. As an applicant, I want to save an answer once, per employer, or globally, so that I control where it can be reused.
8. As an applicant, I want required document requests to show accepted formats, so that I can attach the right file and resume where I stopped.
9. As an applicant, I want evidence of receipt or a reconciliation ticket, so that a lost browser response does not cause a duplicate submission.
10. As an applicant, I want up to three contacts ranked with evidence, so that I can judge who is closest to the role.
11. As an applicant, I want to see prior contact and review both messages together, so that I can change the recipient, edit the wording, or skip outreach.
12. As an applicant, I want separate records for SMTP acceptance and manual LinkedIn delivery, so that I know what still needs action.
13. As an applicant, I want job-search contacts identified in Apollo, so that I can keep them separate from sales work.
14. As an applicant, I want the weekly report to include reviewed denominators and time spent waiting, so that I can choose an improvement based on observed results.

## Implementation Decisions

### Components and credentials

The extension captures the posting, fills the form, uploads the selected documents, and submits in the applicant’s session. The server owns the ledger, résumé, answer bank including work-authorization answers, model calls, authenticated dashboard, review tickets, Apollo integration, and SMTP delivery. Keep the OpenAI key, Apollo key, and Gmail app password in the platform secret store, accessible only to the server.

Use Railway for the pilot server and PostgreSQL ledger, with private object storage for documents and screenshots. The signed-in dashboard issues a revocable, applicant-scoped pairing token. Store it in extension-local storage and send it as a bearer credential over HTTPS on every extension API call. Reject missing, invalid or revoked tokens before reading applicant data or writing the ledger.

### Capture, employer identity, and deduplication

Save both the discovery URL and the employer application URL. Allow a user-supplied employer link or posting text when a discovery site restricts automated access. Track unsupported application hosts for the report.

For an employer-owned application site, use the normalized company domain as its identity key. For shared ATS hosts, use the provider and employer slug, such as `greenhouse:acme` or `lever:acme-corp`. An editable alias table maps domain and ATS keys to a canonical employer ID. A display name such as “Acme Inc.” can suggest a merge. Resolve plausible matches before applying. Merging identities combines submission histories for cap and deduplication checks.

Store a nullable company domain on the canonical employer. Extract it from the posting’s employer website link or propose a domain through Apollo organization enrichment by name. Confirm the domain once in the alias table before using it for people search. Missing or disputed domains pause contact lookup only. When an employer-owned careers page redirects to or embeds a recognized ATS board for that employer, automatically link the observed domain and provider slug, recording both URLs. Conflicting established mappings go to review.

Enforce uniqueness on canonical employer and requisition ID when available. Otherwise match normalized employer, title, and location. Normalize title equivalents such as *Sr./Senior*, *SWE/Software Engineer*, and *II/2*. Distinct known requisition IDs preserve distinct positions even when their titles match. Link duplicate sightings to the existing record before any eligibility processing.

For fallback location matching, normalize work arrangement (remote, hybrid, on-site or unknown), city, state and geographic scope. Preserve country-only restrictions. “Remote” and “Remote - US” have different scopes. “Los Angeles, California” and “Los Angeles, CA” match. Missing components remain unknown.

Import confirmed history from CSV with columns `employer,title,date,source URL` and ISO local dates. Resolve employer aliases on import. An unmatched employer opens a ticket. Once resolved, count the original submission date. Reimporting the same row or linking it to an existing submission counts it once.

### Employer cap and submission holds

At capture, check confirmed submissions including imported history. A capped job shows its next available date. An earlier uncertain submission holds that employer for reconciliation. Both paths stop before eligibility calls or eligibility review tickets.

Default to three confirmed submissions per employer in the configurable window **(today minus three calendar months, today]**, using dates in `America/Los_Angeles`. Clamp month subtraction to the last valid day. On November 8, an August 8 submission has aged out and an August 9 submission still counts.

Capture enqueues work. When the single worker dequeues a job for form fill, resolve its current canonical employer and recheck both cap and hold before eligibility routing or any model call. Finish or durably pause the active job before dequeuing another and repeat the check on resume. With two confirmed and five queued, confirmation of the first blocks the other four without eligibility calls or tickets.

Immediately before the final submit click, atomically recheck the cap and mark the application as submitting. If the session ends before the outcome is recorded, hold that employer until the result is reconciled.

### Eligibility routing

1. **Deterministic exclusion.** Maintain narrow, tested patterns for an explicit citizen/green-card-only restriction, required ITAR eligibility, required security clearance, or an explicit sponsorship bar. A complete, unambiguous requirement excludes the job and records its exact source span. Negation, preference wording, or a conflicting clause prevents automatic exclusion.
2. **Sol classification.** Maintain a separate broad trigger vocabulary covering *visa, sponsor, authorization/authorized, work permit, H-1B, OPT, immigration, ITAR, clearance, citizen,* and *resident*, including spelling and inflection variants. Any trigger without a conclusive exclusion sends the relevant passage and context to `gpt-6.1-sol` via the Responses API with low reasoning effort. For example, “cannot provide visa assistance” takes this route. Verify Sol’s verbatim evidence against the source before accepting a restriction. Unresolved wording or failed verification opens a review ticket.
3. **Pass without a model call.** When neither list matches, pass the eligibility screen. Apply the same routing to new restrictions revealed in the form. Store the decision, its source, and its provenance as rule, Sol, or user.

Budget for Sol on every uncapped, unique posting reaching eligibility, plus triggered passages revealed during form fill. Estimate from measured input and output tokens at the configured rates. Report actual trigger frequency during the pilot.

### Answer bank and documents

First match normalized question text and compatible choices, giving employer-specific answers precedence over global answers. Next check user-approved aliases for that employer’s question. For remaining candidates, Luna compares the question with approved answers available in scope. Reuse requires one equivalent match above a validated threshold, compatible choices, and agreement in polarity, time horizon, and location.

If a required response is missing or its match is uncertain, show the exact question, available choices, employer, and role. Let the user answer once, save for this employer, or save globally. Resume at the paused field. An employer asking about future sponsorship must receive an answer approved for that question even if the user has already answered a question about current authorization.

Attach the saved résumé to the résumé field and skip optional supplemental uploads. A required cover letter, portfolio file, or other document opens a ticket naming the field and accepted formats. Allow the applicant to attach the file and resume or defer the position. Handle a portfolio URL through the answer bank.

### Confirmed submission and outreach

Each ATS adapter defines a tested success selector and expected acknowledgement text. On a match, store the text, confirmation screenshot, final URL, and timestamp. A redirect alone leaves the outcome uncertain and holds the employer. Start contact research only after confirmation.

At setup, verify the Apollo API key, endpoint access, and credit balance. Filter by confirmed company domain and relevant titles before passing at most **10 candidates** to `gpt-6-luna`. Return up to three people, each with a score from 1–5, a brief reason, and supporting evidence. Favor a named hiring contact or confirmed team manager. Flag any prior outreach to the selected person.

Use Apollo `people_match` for the selected recipient’s business email. Keep phone, personal-email, and waterfall enrichment disabled. Keep the shortlist in the application ledger. Add any Apollo contact saved by this workflow to **Job Search** and preserve existing sales fields and list memberships. Use existing credits, respect endpoint limits, and pause on exhaustion. [Apollo enrichment](https://docs.apollo.io/reference/people-enrichment) · [Apollo contact lists](https://docs.apollo.io/reference/create-a-contact)

Luna drafts one email and one LinkedIn note. The review ticket supports editing, changing the recipient, approving, or skipping. Approval sends one email to a verified business address through personal Gmail SMTP over TLS. Verify app-password access at setup and respect account sending limits. Record SMTP acceptance and reconcile an uncertain send before retrying. Provide the profile link and copyable note for manual LinkedIn delivery, with its own completion control. Automated invitations require partner access unavailable to this pilot. [Gmail app passwords](https://support.google.com/accounts/answer/185833) · [Gmail sending limits](https://support.google.com/mail/answer/22839) · [LinkedIn invitation access](https://learn.microsoft.com/en-us/linkedin/shared/integrations/communications/invitations)

Configure OpenAI model IDs through environment variables. Record provider, model, prompt version, and token usage with every result. Sol handles unresolved eligibility language. Luna handles answer equivalence, ranking, and drafting. [OpenAI deployment guidance](https://developers.openai.com/api/docs/guides/deployment-checklist)

### Seven-day report

Seven days after the first live decision, publish exactly three charts.

| Chart | Measures |
| --- | --- |
| Application funnel | Selected, duplicate, capped, eligibility-excluded, confirmed submitted, and outreach reviewed. Show email acceptance and manually recorded invitations separately. |
| Pauses by cause | Distinct jobs affected and waiting time by cause, including unanswered questions, required files, eligibility ambiguity, unsupported forms, provider limits, and uncertain submissions. |
| Corrections | Edited drafts, changed rankings, missed restrictions, and reversed exclusions, with the reviewed denominator for each. Randomly sample 10 distinct passed and 10 distinct excluded postings, or all available in a smaller group. Persist sampled IDs and count completed reviews separately from selections to detect errors that did not open a ticket. |

Below the charts, identify the largest observed bottleneck and recommend one improvement supported by its records. Distinguish intended eligibility exclusions from application failures.

## Testing Decisions

Test observable behavior through the extension, ledger, tickets, provider boundaries, and report. The workspace has no prior implementation or test suite. Use synthetic postings, contacts, and provider responses for repeatable release tests.

- **Answer-matching bootstrap.** Before launch, seed 30–50 handwritten question pairs spanning current and future authorization, sponsorship, relocation, salary, start date, and clearance. Include paraphrases and near-misses. Select the threshold on the calibration portion, check it on held-out pairs, and refine it with reviewed pilot tickets. A changed polarity or material qualifier must prevent reuse regardless of score.
- **ATS replay.** Replay a complete flow on each of Greenhouse, Lever, and Ashby. Cover cross-board duplicates, employer alias merges, distinct requisitions with identical titles, exact-date and month-end boundaries, imported applications, and a cap change immediately before submit. Replay five queued jobs with one remaining slot, including worker restart. Assert zero eligibility calls and zero eligibility tickets for an already-capped employer.
- **Eligibility.** Use labeled postings for all three routes. Include exact requirements, preference and negation cases, and ambiguous wording. Verify source quotes and track false inclusions and false exclusions separately. Rerun the evaluation before changing the model or prompt.
- **Forms and receipts.** Exercise answer reuse and scoping, a required Lever upload, an optional supplemental field, and resuming at the same field. Verify receipt evidence on success and the employer hold after a redirect or uncertain submit.
- **Outreach.** Verify the Apollo input limit, one enriched recipient, repeat-recipient flag, Job Search membership, and preservation of existing sales records. Verify zero outreach before confirmation, zero email sends before approval, and at most one approved email per position after a timeout.
- **Reporting.** Replay a seven-day ledger with known outcomes, pauses, review samples, and corrections. Check all three chart counts and denominators against the ledger and trace the reported bottleneck to the affected records.

## Out of Scope

Defer Workday, Workable, concurrent applications, multi-provider settings, local inference, and Linear integration. Follow-on work includes automatic outreach for eligible cases, résumé tailoring from a structured experience inventory, skill-gap analysis, and learning roadmaps. Revisit confirmation-email matching if uncertain submissions are a material pilot bottleneck.

## Further Notes

**Copyable prompt for the separate local-LLM host**

> Build a drafts-only local LLM service on the designated host. Inspect its hardware before choosing a model and quantization. Accept job details, evidence about one selected contact, and approved applicant facts. Return validated JSON containing a LinkedIn note, email subject, and email body. If using Qwen3, disable thinking with `/no_think`. Provide an authenticated interface and setup, start, stop, and test instructions. Evaluate unsupported claims, reviewer edits, latency, and peak memory. The main pipeline owns eligibility, ranking, submission, and delivery.
