# Publish the seven-day pilot report

## Parent PRD

[Job application and outreach pilot](prd.md)

## What to build

Two parts. **013a** builds the three charts against a fixture ledger as soon as the 001 reporting contract is frozen. **013b** publishes the live report seven days after the first live decision.

## Acceptance criteria

- [ ] Reconcile exactly three charts against a fixture ledger: funnel, pauses and corrections with reviewed denominators.
- [ ] Sample ten passed and ten excluded, or all available. Preserve IDs and track actual reviews.
- [ ] Identify the largest observed bottleneck, link its records and propose one improvement.
- [ ] The clock starts at the first live decision in 007. Record `adapter.available` per host and show each host's coverage window in the funnel.
- [ ] On day seven, publish all three charts even if an adapter or outreach delivery is still unavailable. Label each chart's coverage (hosts live, outreach live, days covered) so missing data reads as absent, not zero.

## Blocked by

- 013a: [001-paired-capture.md](001-paired-capture.md) (reporting contract)
- 013b: [007-greenhouse-receipt.md](007-greenhouse-receipt.md) (clock start) and 013a
- Soft for 013b: [008-lever-application.md](008-lever-application.md), [009-ashby-application.md](009-ashby-application.md), [012-deliver-outreach.md](012-deliver-outreach.md). Publication does not wait for them; the report labels their coverage.

## User stories addressed

User story 14
