# Crew QA build, September 16, 2026

**The integrated local crew implementation is installed and ready for operator
QA. Full qualification across real external harnesses remains unfinished.**
This updates the status in the
[September 15 assessment](crew-qualification-2026-09-15.md), whose individual
historical receipts retain their original scope.

## Installed build

Root built from clean, committed source
`8316dadabe4323ca814dca261668474aed309511`, signed and installed
Junto **0.3.0** at `/Applications/Junto.app`. The package
contains schema **24** and the additive **23 to 24** migration. Build cohort:
`292ea24d-176d-4461-bce3-ef6e1056aeec`.

Both candidate and installed package passed runtime provenance verification.
Their app archives and standalone CLI binaries were byte-identical:

| Payload | SHA-256 |
|---|---|
| App archive | `9c8b3af29ac75fca4554591f1337783b043c0a8fdd0f2401145be95b93798481` |
| Standalone CLI | `fe7c329e7bf85be734ee99a12fb0f9744cfc0e91eb7cbde783ea3cfaf7acc7b2` |

Signature team: `4452968868`. Installed CDHash:
`cec5acfe3a99b1b012acae089482feb5c0a8ebeb`.

Computer Use opened the explicit installed path at approximately 02:20 BRT.
The new main process, PID `4792`, ran from that path and rendered the operator's
existing Factory canvas with Saved and Playing status. The operator subsequently
began QA and reported that it was going well. This observation proves successful
installed startup and canvas rendering; it is not a feature-by-feature native
harness certification.

## Checked gates

| Gate | Observed result |
|---|---|
| Full `bun run verify` | Exit 0; lints, type checking, unit suites, shipping-profile checks and Electron compilation passed |
| Unit suites | 7,685 passed, 62 skipped |
| Shipping-profile tests | 30 passed, 7 skipped |
| Six crew Playwright specs | 27 passed, no failures or skips, 1.4 minutes |
| Signed packaged runtime smoke | Passed isolated startup, bundled CLI, protected controls, process shape and clean shutdown; real product roots unchanged |
| Candidate/staged/installed package audits | Passed |
| Source ownership | All closure changes committed; working tree clean before installation |

The Playwright run covered mail, immediate prompts, seat wait, terminal read and
follow, task wait, review gates, a complete receipt/blocking/repair/green cycle,
mail ledger rendering, edge masks, review authoring and the verdict chain. Its
generated canvases use simulated harness processes over real PTYs and real app
control. Those processes do not establish external-model delivery or read
receipts.

## Closure changes

- `7935f4545` fixes the stale mail ledger: crew attempt commits now notify the
  shared StateEngine-scoped work projection subscribers after commit. A real
  Canvases regression checks committed facts, idempotent no-ops, rollback and
  reconciliation. The formerly red ledger E2E passed in the complete run.
- `1255c9db7`, `47a3e4350` and `3c0a286b4` update old test assumptions after the
  strict acknowledgement change. Successful fixtures supply positive turn
  acknowledgement; empty/readiness-only captures remain unresolved without it.
- `8316dadab` makes the under-budget reporting test deterministic without using
  filesystem scheduling as its clock. The real slow-write test remains intact.
- `536e683d5` already covered terminal read/follow when the seat exits during
  the follow. That path passed in this complete E2E run.

## Remaining qualification

1. Obtain isolated real-harness mail-to-read evidence, starting with Devin,
   preserving exact build/process/generation identity, physical write counts,
   pending evidence and durable read facts. Record authentication or setup
   limitations explicitly for other harnesses.
2. Exercise durable restart/resume and checkout receipt delivery through the
   packaged composition. Current real-database/unit evidence does not substitute
   for those packaged lifecycle journeys.
3. Incorporate concrete findings from operator QA. The running production build
   remains fixed during that QA; subsequent documentation or bookkeeping does
   not change its recorded source identity.

Remote remains outside this iteration. No native channel or typed-notice
qualification flag should be enabled from the generated-harness results alone.

## Local run receipts

These are local execution artifacts, not committed logs:

- `/tmp/vellum-command-final-verify.log`
- `/tmp/vellum-command-final-crew-e2e.log`
- `/tmp/vellum-command-final-build.log`
- `/tmp/vellum-command-final-package-smoke.log`
- `/tmp/vellum-command-final-install.log`
- `/tmp/vellum-command-final-installed-provenance.json`
- `/tmp/vellum-command-qa-ready-20260916.md`
- `test-results/crew-review-cycle-crew-rev-dd7b0-each-the-live-verdict-chain/crew-verdict-chain.png`

The review-cycle result directory also contains the final canvas, runtime
identity, terminal write trace and author/reviewer process-event receipts.
