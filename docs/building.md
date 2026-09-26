# Building Junto from source

Requirements: Bun 1.3.13 (see `package.json`), Node.js 24.10 or later, macOS or Linux with an interactive desktop session, Git, and the platform's native build tools.

```sh
git clone https://github.com/skastr0/junto.git
cd junto
bun install --frozen-lockfile
bun run dev
```

The development app uses `~/.junto-dev/`. The packaged app uses `~/.junto/`.

## Packaging

```sh
bun run build              # package locally, skipping source checks
bun run app:build:mac      # local macOS package, run on macOS
bun run app:build:linux    # local Linux desktop package, run on Linux
```

Local packages are development builds without a signing identity. Automatic updates need the official signing identity compiled into an official build. Signing and notarization (`bun run app:build:ship`, `scripts/notarize-app.sh`) need the maintainer's Developer ID and Apple notary credentials. GitHub Releases are not the app's update feed.

## The CLI

```sh
bun run cli:build          # writes dist/junto
```

Packaged apps include the same CLI as `bin/junto`. Commands that touch the work plane must run inside a seat the app started; outside one they return an `AuthError`.

Read-only views of the running app's canvases:

```sh
bun run canvas:ls          # list canvases
bun run digest <canvas>    # text digest of one canvas
bun run render             # SVG export
```

## Checks

```sh
bun run verify                 # lints, typecheck, tests, ship-profile checks, compile
bun run test:e2e               # GUI startup smoke
bun run test:e2e:fast <spec>   # one GUI spec against an existing build
bun run test:e2e:full          # full GUI regression suite
```

Official builds use the `ship` feature profile. Each feature in [`src/shared/feature-catalog.ts`](../src/shared/feature-catalog.ts) has one of three tiers:

- **off**: compiled out, because it is not built yet or is pruned for launch. Task queues, boards, pads, sheets, browser pages, schedulers, Fleet, Remote and the voice overseer are off in official builds.
- **experimental**: compiled in, but off until the operator turns it on in Settings, Experimental. The toggle is a product setting (`advanced.experimental` in `junto.db`). Seat awareness (Jev) ships this way, and it still needs its `TYPESAFE_API_KEY`.
- **on**: compiled in and on.

A build override takes `0`, `1` or `experimental` (for example `JUNTO_SEAT_AWARENESS=experimental`). Only a feature whose catalog entry declares an `experimental` block (with its Settings title and description) may take the middle tier. The build refuses the tier for any other feature. Code reads a tiered feature through one resolved predicate, `featureOn(key, optIns)`: compiled, and either on or turned on by the operator. It never reads the tier alone. The build receipt lists the experimental features separately from overrides. Its fingerprint writes `1` for on, `x` for experimental and `0` for off.

Linux desktop: see [the Linux desktop guide](linux-command-center-alpha.md) and [the bootstrap guide](linux-desktop-bootstrap.md).
