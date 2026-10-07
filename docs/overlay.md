# Build-time overlay

This repository builds the complete open-source Junto app. A private overlay
adds premium commercial content (the store and purchase delivery surface,
and the premium items of the Junto cast), **at build time**. Junto Plus is
unreleased: the overlay is available only in explicit local previews, never
production builds or packages. Nothing premium is read from disk at run time;
it is compiled into the preview bundle. A fork that builds this repository
gets no store and no premium items, by design.

## Production quarantine

Production builds reject a nonempty `JUNTO_OVERLAY` before compilation.
Development and the named Vite mode `overlay-preview` may resolve it; other
build modes, `NODE_ENV`, feature overrides, and payment environment variables
cannot authorize it. There is no production override or readiness flag.

Both native packagers also reject previously compiled preview output before
creating a package attempt. Electron-builder's shared `afterPack` hook checks
the actual `app.asar` before signing, so unsetting `JUNTO_OVERLAY` or invoking
electron-builder directly does not promote a preview into a release.

Lifting this quarantine requires a deliberate release-policy change after
checkout and purchase/entitlement delivery are implemented and verified.
Supplying a payment URL or credentials is not proof of a working checkout.

There is one Junto cast, and Pip and the brand cast belong to it: they, the
portrait engine and editor, the pack format, and every brand surface (app
icon, DMG, tour guide) are in this repository. Free vs premium is only which
items are unlocked. The free items (`src/shared/cosmetics/free-pack.ts`) are
four species, every palette and accent, every face, every mood, and two basic
items in each other category; every other species, topper, pattern, and prop
is a premium item in the overlay.

## How it resolves

`JUNTO_OVERLAY` names an overlay checkout. `scripts/overlay.ts` maps the
`@junto/overlay` alias to its `overlay/` directory, or, when the variable is
unset, to the in-repo stub `src/overlay-oss/`. The electron-vite config,
Vitest (always the stub), and `tsconfig.json` (the stub, for typechecking)
share that resolution.

| Entry | Export | Type | Stub |
| --- | --- | --- | --- |
| `@junto/overlay` | `overlay` | `OverlayManifest` | marker `junto-overlay:oss`, no cosmetics |
| `@junto/overlay/renderer` | `surfaces` | `OverlaySurfaces` | `{}` |

The contract is `src/shared/overlay-contract.ts`. App code reads the decoded
manifest from `@shared/overlay` (`overlayManifest`) and renderer slots from
`src/renderer/overlay/surfaces.tsx` (`StoreSlot`, `hasStore`). Cosmetic packs
stay raw in the manifest; the portrait system decodes each one with
`src/shared/cosmetics/pack-schema.ts` and drops a bad pack alone. A pack may
keep bare keys (`keys: "bare"`: its items resolve by plain id, so looks saved
before an item moved keep resolving) and may declare the seat-identity draw
(`identity`): with it installed, seats are born from its lists; a drawn item
this install may not wear falls back to the free items' list with the same
roll.

Saved portrait overrides keep their cosmetic IDs in `junto.db`, even when a
build lacks those items. Rendering substitutes the seat's free identity look
for each unavailable slot without saving the substitute. A cold reopen or an
edit to another portrait field retains those IDs; installing the same content
again makes them resolve. Reset, Randomize, or replacing that slot intentionally
changes the saved selection. Automatic seat looks are derived from the seed
and currently installed identity tables, so their appearance may also differ
between a Plus preview and an OSS-only build without rewriting any state.

The build also defines `__JUNTO_PREMIUM__` (true only with `JUNTO_OVERLAY`),
read as `PREMIUM_BUILD` in `src/renderer/overlay/surfaces.tsx`. Every premium
surface (the store host and its command, locked items, pack headings, Get)
is behind it, so the open-source bundle does not carry them at all: it shows
the free items, fully usable, and nothing else. An item nobody can wear and no
store can sell is not shown, never greyed out.

Overlay files import app code through `@shared/*` and `@renderer/*`, and
packages (react, effect) resolve from this app's `node_modules`, so a build
has one copy of each.

## Build

```bash
# Production app, always OSS-only while Plus is unreleased
env -u JUNTO_OVERLAY bun run app:build

# Local Plus development preview, not a package
JUNTO_OVERLAY=../junto-premium bun run dev

# Compile a local preview outside production out/
JUNTO_OVERLAY=../junto-premium bunx --no-install electron-vite build \
  --mode overlay-preview --outDir .amp/in/overlay-preview
JUNTO_OVERLAY=../junto-premium bun scripts/lint-overlay.ts --bundle \
  --preview --out .amp/in/overlay-preview
```

`app:build` prints the OSS receipt and refuses overlay selection, including
`--fast` and `--compile-only`. A preview still fails on a path without
`overlay/index.ts`; `bun scripts/overlay.ts --receipt --preview` prints its
overlay commit explicitly as a preview.

## Gates

- `bun run lint:overlay`: overlay code is reached only through the alias.
- `bun run check:overlay-bundle` (after a build, also run by `verify` and
  `app:build`): production `out/` carries no overlay marker but the stub's
  and no premium UI. Only `--preview` may admit a preview overlay marker.
  With a premium checkout on the
  machine (`--premium DIR`, `JUNTO_PREMIUM`, or a sibling `../junto-premium`),
  it also fingerprints every premium item (its path data, or its id and name
  side by side) and fails if an open-source `out/` holds any. Pip and the
  brand cast are open source and not fingerprinted.
- `bun scripts/lint-overlay.ts --bundle --asar FILE`: checks packaged app
  code under the same OSS-only rule; `--preview` is forbidden for archives.
