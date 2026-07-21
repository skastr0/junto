# Security Policy

## Supported Status

Vellum Command is a **stable**, solo-maintained macOS desktop product. Security reports for the current release line are reviewed on a best-effort basis.

| Version or branch | Supported |
| --- | --- |
| Latest GitHub Release | Yes |
| `main` (pre-release commits) | Best-effort |
| Older releases | No (upgrade to latest) |

## Reporting A Vulnerability

Do not open a public issue for suspected vulnerabilities.

Report privately through:

- GitHub Security Advisories for this repository (preferred when the repo is public)
- Or contact the maintainer via the GitHub profile linked from this repository

Include:

- affected version, commit, or release artifact
- reproduction steps
- expected impact
- relevant logs or proof of concept (redact secrets)
- whether the issue appears exploitable in default configuration

Please redact tokens, personal data, private endpoints, and unrelated secrets from reports.

## Scope

In scope:

- Vellum desktop app (Electron main, preload, renderer)
- Packaged release artifacts published via official GitHub Releases
- Local control sockets, capability grants, browser/herdr/hermes integration as shipped

Out of scope:

- Unsupported versions or forks
- Social engineering
- Denial-of-service against maintainer infrastructure
- Findings that require an already-compromised local machine unless Vellum materially increases impact
- Third-party CLIs/services the app may call (report those upstream)

## Disclosure

The maintainer will coordinate disclosure timing based on severity, available fixes, and user impact. No fixed response-time SLA is promised.

## Supply Chain Notes

Official release channels:

- GitHub Releases for this repository (`skastr0/vellum`) — notarized macOS `.zip` / `.dmg` when published

Do not trust binaries, packages, or install commands from channels not listed here.
