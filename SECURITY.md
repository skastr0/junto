# Security policy

Junto is a side project with one maintainer, not a hosted service. There is
no support email, security mailbox, or private support channel. Linux desktop is
alpha; Fleet and Remote stations remain experimental and disabled in the default
feature profile. Older versions do not receive backports.

## Reporting a vulnerability

Open a [GitHub issue](https://github.com/skastr0/junto/issues) titled as a
security report. Describe the affected area, the version or commit, platform,
build channel, enabled feature profile, and expected impact. Leave out working
exploit code, credentials, personal data, and unrelated logs; the maintainer
will ask in the issue for anything more that is needed.

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
[Junto download page](https://juntoagents.com/download). The official release
process signs every macOS build with a Developer ID certificate and notarizes
it with Apple before publishing it; automatic updates use the app's configured
maintainer-run release feed. Linux first install is authenticated by an
independently obtained bootstrap or a reviewed source checkout, not by the
download-page checksum or the archive's bundled CLI. Source availability does
not make arbitrary third-party builds official. GitHub Releases are not the
automatic update feed; they may host the attested Linux first-install bootstrap.

Fixes land when the maintainer gets to them. There is no response time and no
bug bounty.
