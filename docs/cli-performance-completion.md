# Agent CLI performance completion

Completed 7 October 2026. This pass covers ordinary local agent CLI calls, managed-seat generation identity, CLI startup, and concurrent socket admission. Inactive features are excluded by the operator's scope decision.

## Delivered behavior

Main issues `JUNTO_WORK_TOKEN` for an occupant generation and injects it into the managed launch environment. The CLI reads it automatically and presents it on the shared Work socket. Ordinary admission resolves an in-memory credential rather than reconstructing process ancestry. Current canvas connections still determine authority. Replacement, offboarding, detach/reanchor, and in-flight revocation retain their lifecycle checks.

The CLI now loads its selected command family. Root help still loads the complete enabled command tree. Schema and example discovery remain available offline. `--version` needs neither a credential nor a server. Small capability annotations no longer initialize the full schema/catalog modules. Runtime imports use the Effect v4 Bun leaf modules.

The default 32-client application ceiling is removed. Explicit runtime overrides remain supported, alongside existing frame, time, and shutdown controls. A regression holds 33 clients open concurrently and verifies every response.

Implementation receipts: identity `4cd0e93b4` and its launch/lifecycle predecessors; startup `3223ff017`, `9d0603089`, `912e46db1`; connection admission `4e8c5b9fb`.

## Measured qualification

The [reproduction script](../scripts/cli-performance-qualification.ts) starts a separate temporary runtime using the real Work, Canvases, and SQLite services. It launches the packaged ship-profile CLI with a temporary generation credential. It does not connect to the installed app or production database. Credentials never enter output, artifacts, or argv.

The eager CLI was built from `286512185`; the optimized CLI contains the three startup commits above. Both use the same token-based server. Two rounds reverse the variant order. Each variant has 24 serial samples per command and two 24-process bursts. Desktop background load is not controlled.

| Measurement | Eager CLI | Optimized CLI |
|---|---:|---:|
| Offline `--version`, median | 79.5 ms | 44.1 ms |
| Packaged `ping`, serial median | 86.5 ms | 75.1 ms |
| Packaged 24-call burst, request median | 562.7 ms | 288.0 ms |
| Packaged 24-call burst, total wall time per round | 619–748 ms | 375–444 ms |

With the CLI startup bypassed, 24 fresh token-authenticated socket calls completed in **6.8 ms**; 64 completed in **12.5 ms**. All **292 timed operations succeeded**. Instrumented peer-PID, process-map, parent, and start-key observations remained **zero**, including the ordinary doctor/onboard/capabilities/mailbox qualification calls. Both packaged root-help outputs were byte-for-byte equal.

The [raw qualification evidence](research/cli-performance/qualification.json) includes every timing, server timer observations, success counts, binary hashes, and measurement order. Server timer observations are not renderer frame or terminal input-latency measurements. The earlier installed-app baseline used a different runtime workload, so these results do not establish a like-for-like percentage improvement over that production app.

## Validation and delivery boundary

An isolated snapshot containing the identity, startup, and connection changes passed:

- `bun run typecheck`.
- `bun run test`: 532 shared files / 5,697 tests; 269 isolated files / 3,158 tests. Reported skips: 13 shared and 36 isolated tests.
- Active CLI compatibility, generation registry, managed launch, transport, and revocation suites: 192 passed, one skipped before the additional connection regression. The Node-run loader/transport check after that change passed 38 tests, one skipped.
- Official ship-profile standalone build, packaged help parity, and the qualification script above.

The generation and managed-launch tests, plus [harness qualification](cli-harness-identity-qualification.md), cover environment precedence, nested tool shells, stale credentials, failed launch, suspend/reanchor, and in-flight cancellation. The installed Codex default environment policy and Prime/Pi shell backends were exercised separately in that harness qualification; this pass does not claim a new live session test for every vendor.

The source changes and qualification are complete. The installed app and shared `dist/junto` were not replaced or restarted. These results prove the isolated agent CLI path; they do not claim a measured renderer-stutter fix in the currently running app.

## Reproduce

Build the eager and optimized CLI in separate disposable checkouts using `bun run cli:build`, then pass their absolute executable paths:

```sh
bun scripts/cli-performance-qualification.ts /tmp/junto-cli-qualification.json EAGER_CLI OPTIMIZED_CLI
```

The script creates and removes its own temporary runtime and uses environment injection for its temporary credential. Use isolated checkouts so qualification never overwrites the shared CLI paired with the running app.
