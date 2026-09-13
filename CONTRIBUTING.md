# Contributing to Vellum Command

Vellum Command is solo-maintained. The contribution channel is
[GitHub issues](https://github.com/skastr0/vellum-command/issues): reproducible bugs,
documentation corrections, and focused proposals are welcome.

Unsolicited pull requests are not accepted. If the maintainer explicitly invites a
patch for an issue, agree on its scope first. Invited contributions use the
project's Apache-2.0 license unless an existing third-party notice applies.

## Useful reports

Include the version or commit, operating system and architecture, install channel,
steps to reproduce, expected behavior, and actual behavior. For source builds,
include Node and Bun versions. State whether experimental features are enabled.

Use a minimal example and redact personal paths, hostnames, account information,
tokens, and unrelated logs. Feature proposals should explain the work they enable
and the maintenance cost they introduce.

## Working on an invited patch

Follow [the source setup](README.md#build-from-source) and [AGENTS.md](AGENTS.md).
Keep changes focused and run:

```sh
bun run verify
```

The unit suite declares native prerequisites at the test that needs them. Linux
install mutation and GNU tar release-publication cases skip automatically on
macOS, including when a single test file is passed directly to Vitest. Run
those cases in a Linux environment; portable validation and calculation tests
remain part of the local run on both platforms.

Run targeted GUI checks when behavior changes (`bun run test:e2e:fast <spec>`;
`bun run test:e2e:audit` for design review). The full regression
(`bun run test:e2e:full`) is not routine. Do not include generated captures,
local state, credentials, private endpoints, or scanner output in the patch.

## Security and support

Use [SECURITY.md](SECURITY.md) for private vulnerability reports.
[SUPPORT.md](SUPPORT.md) describes the project's support boundaries. Issues are
reviewed on a best-effort basis; no response time or implementation is promised.
