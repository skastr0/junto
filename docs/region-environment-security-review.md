# Region environment security review

Reviewed on 2026-10-07. This review covers region configuration, source resolution,
secret storage, launch environments, reports, IPC/control access, process cleanup,
and the feature's examples and tests. It is not a whole-application security audit.

## Findings and fixes

| Finding | Evidence | Result |
|---|---|---|
| High: command stderr could disclose credentials through environment reports | A failed command with empty stdout and a canary on stderr returned that canary in `reason`. The reason reaches region IPC reports, seat `env.report`, and overseer `env.doctor`. | [sources.ts](../src/main/junto/region-env/sources.ts) now reports status without forwarding either output stream. Regressions cover unknown, short, and encoded stderr values. |
| Medium: inherited Connect settings overrode an explicit service-account selection | The `tokenFrom` branch added the selected token to the entire ambient tool environment. [1Password's documented precedence](https://www.1password.dev/service-accounts/use-with-1password-cli) makes Connect credentials win in that environment. | The explicit-token branch removes Connect credentials from a private copy. The base environment is unchanged; no-selection behavior is retained. |
| High: removing one source deleted a secret used by other sources | Two sources can reference the same `secretId`. Removing one called the store's delete operation without checking other regions or canvases. The shared-reference regression failed before the fix. | [RegionEnvironmentScreen.tsx](../src/renderer/components/region-environment/RegionEnvironmentScreen.tsx) only unlinks the source. Stored secrets remain until explicit retirement through the secret-delete operation. |
| Medium: timeout left subprocesses running outside app-owned cleanup | A timed-out command's child wrote a disposable marker after its parent was killed. The old runner used `execFile` outside the central process plane. | [tool.ts](../src/main/junto/region-env/tool.ts) registers an owned process group. Timeout and output overflow signal that lease, and app quit drains it. Regressions cover the child, output limit, shutdown, and refusal to spawn after shutdown. |

The secret-store save boundary also forwarded backend exception text. A fake backend
that quoted the submitted value proved this violated the boundary's contract; this
was not evidence that the built-in Keychain backend had disclosed a real value.
[secret-store.ts](../src/main/junto/region-env/secret-store.ts) now returns fixed words.

Generic UI/CLI examples and fixtures use fictional variables and item names. The
manual test that read an operator-selected real Keychain item was removed. The
standard `OP_SERVICE_ACCOUNT_TOKEN` name remains in the 1Password adapter, where
the external CLI requires it, and in a synthetic credential-isolation test.

[unit-test-environment.ts](../scripts/unit-test-environment.ts) removes inherited
credential variables and authenticated proxy URLs before unit-test workers start.
The Vitest setup applies the same filter for direct targeted runs. Tests install
synthetic credentials explicitly. This is name-based filtering, not a claim that
an arbitrary variable cannot contain a secret. The runner also loads Electron once
before parallel workers, preventing the cold-download race observed during this review.

## Exposure checks

An exact-match scan of the ambient token, performed without printing its value,
found no matches in 2,467 tracked files, 27,354 reachable Git blobs, 444 unique
installed-app files, or 1,270 entries in the downloaded public 0.4.1 ZIP. The Git
scan also found no long 1Password service-account token strings. Private-key header
matches were checked and were format declarations or explicit fake test data.

These checks do not retract the earlier token exposure in local test/session
output. They do not cover ignored logs, external session storage, older credentials,
or every possible credential format. No real product database was opened for this
review, and no real Keychain or 1Password credential was used by the regressions.

## Boundary checks

Resolved values flow to the selected child's environment. Launch records and
terminal summaries omit values. Secret saves return ids only; renderer secret
drafts are dropped after saving. Reports omit successful values. Secret-store
writes use stdin or owner-only files rather than command-line values. The explicit
plain-value source remains document data, as its UI states.

Secret IPC handlers use the trusted-main-renderer facade. Ordinary seat reports
use process-bound work admission and return the caller's own report. Remote
overseer calls cannot forward secret-store operations to Command Center. These
were source checks; multi-station behavior was not exercised on a live fleet.

The final review pass retraced stderr-to-report disclosure, checked the process
group path that the initial scan nearly missed, and verified the IPC facade and
credential-store implementations rather than assuming their comments were sufficient.

## Validation

The fixes are committed in `16ecfa50d`, `e390103c3`, `db967aa49`, and `8010e891a`.
At `d10bb647672e14c5ad918ef161d03c9dcf685a12`, `bun run verify` passed all lints,
typechecking, 8,706 unit tests, 42 ship-profile checks, compilation, and the OSS
overlay bundle check. The targeted security and region-environment run passed
241 tests. The disclosure, shared-secret, credential-precedence, and orphan-child
regressions were observed failing before their respective fixes.

The installed and published 0.4.1 release was built with the official Plus
overlay at `5f067f078e73622f24707ffb3931624613bec5c9`. Its final build log names
that revision and passes the official overlay check. The installed `app.asar`
contains `junto-overlay:junto-premium` in both main and renderer bundles.

The source fixes do not update the installed or published 0.4.1 binary. A new
production build and release is required to deliver them to installed users.
