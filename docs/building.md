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

Official builds use the `ship` feature profile. Work in progress (task queues, boards, pads, sheets, browser pages, schedulers, Fleet, Remote, seat awareness, the voice overseer) sits behind flags in [`src/shared/feature-catalog.ts`](../src/shared/feature-catalog.ts) and is off in official builds.

Linux desktop is alpha: see [the Linux desktop guide](linux-command-center-alpha.md) and [the bootstrap guide](linux-desktop-bootstrap.md).
