# Security Policy

## Supported Status

Vellum Command is a **closed-source, privately distributed macOS application**.
The current customer distribution is a private beta, and security reports for
the current signed build are reviewed on a best-effort basis.

| Build | Supported |
| --- | --- |
| Current signed Vellum Command build | Yes |
| Authorized development builds | Best-effort |
| Older signed builds | No (upgrade to the current build) |

## Reporting A Vulnerability

Do not open a public issue for suspected vulnerabilities.

Report privately to **support@vellumcommand.com**. Do not open a public issue or
publish reproduction details.

Include:

- affected version, commit, or release artifact
- reproduction steps
- expected impact
- relevant logs or proof of concept (redact secrets)
- whether the issue appears exploitable in default configuration

Please redact tokens, personal data, private endpoints, and unrelated secrets from reports.

## Scope

In scope:

- Vellum Command desktop app (Electron main, preload, renderer)
- Packaged release artifacts served from the Vellum Command download page and
  Cloudflare Worker/R2 update feed
- Local control sockets, capability grants, browser/herdr/hermes integration as shipped

Out of scope:

- Unsupported or modified local builds
- Social engineering
- Denial-of-service against maintainer infrastructure
- Findings that require an already-compromised local machine unless Vellum Command materially increases impact
- Third-party CLIs/services the app may call (report those upstream)

## Disclosure

The maintainer will coordinate disclosure timing based on severity, available fixes, and user impact. No fixed response-time SLA is promised.

## Supply Chain Notes

Official customer channels:

- [Vellum Command download page](https://vellumcommand.com/download) — the
  customer entry point for the signed and notarized macOS build
- The Cloudflare Worker feed compiled into the packaged app at
  `src/main/vellum/update/compiled-config.ts` — automatic updates and their
  immutable artifacts

The GitHub repository is a private source and control surface, not a release
channel. GitHub Releases are not authoritative for Vellum Command. Do not trust
binaries, packages, or install commands from channels not listed here.
