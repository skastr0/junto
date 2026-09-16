# Security policy

Junto is actively developed and solo-maintained. Security reports for
the current source and official builds are reviewed on a best-effort basis.
Linux desktop is alpha; Fleet and Remote stations remain experimental and disabled
in the default feature profile. Older versions do not receive a separate backport
or support commitment.

## Private reports

Email **support@vellumcommand.com**. Do not publish vulnerability details in a
GitHub issue or pull request.

Include the affected version or commit, platform, build channel, enabled feature
profile, reproduction steps, and expected impact. Redact credentials, personal
data, and unrelated operational details from logs and examples.

## Scope

The application, its local control and IPC surfaces, browser integration, Station
boundaries, and official package/update verification are in scope. Source-build
reports are useful when they reproduce on the current supported dependency set.

The governing [security doctrine](docs/security-doctrine.md) describes a single
operator with trusted but fallible agents. The app enforces operator intent within
its own boundaries. It does not claim to isolate mutually hostile processes
already running as the same operating-system user.

Report vulnerabilities in third-party tools and services upstream. Social
engineering, attacks on maintainer infrastructure, and unsupported forks are
outside this project's review scope. A same-user finding is relevant when the app
creates authority or increases impact beyond the documented trust model.

## Distribution and disclosure

Official binaries are linked from the
[Junto download page](https://vellumcommand.com/download). Official macOS
builds are signed and notarized; automatic updates use the app's configured
maintainer-run release feed. Linux first install is authenticated by an
independently obtained bootstrap or a reviewed source checkout, not by the
download-page checksum or the archive's bundled CLI. Source availability does
not make arbitrary third-party builds official. GitHub Releases are not the
automatic update feed; they may host the attested Linux first-install bootstrap.

The maintainer coordinates disclosure around severity, available fixes, and user
impact. No response-time SLA or bug bounty is promised.
