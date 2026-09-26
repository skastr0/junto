# Build-time overlay

This repository builds the complete open-source Junto app. The official build
adds premium content (the store and purchase delivery surface, the premium
cosmetic packs, and the private brand: Pip and the brand cast) from a private
overlay repository, **at build time**. Nothing premium is read from disk at
run time; it is compiled into the bundle. A fork that builds this repository
gets no store, no premium items, and no mascot, by design.

What stays open: the whole portrait engine and editor, the pack format, four
species, every palette and accent, every face, every mood, and the most basic
ears, patterns, and props (`src/shared/cosmetics/base-pack.ts`). The neutral
Junto mark (`src/shared/brand-mark.ts`) is the open-source app icon, DMG, and
tour guide.

## How it resolves

`JUNTO_OVERLAY` names an overlay checkout. `scripts/overlay.ts` maps the
`@junto/overlay` alias to its `overlay/` directory, or, when the variable is
unset, to the in-repo stub `src/overlay-oss/`. The electron-vite config,
Vitest (always the stub), and `tsconfig.json` (the stub, for typechecking)
share that resolution.

| Entry | Export | Type | Stub |
| --- | --- | --- | --- |
| `@junto/overlay` | `overlay` | `OverlayManifest` | marker `junto-overlay:oss`, no cosmetics, no brand |
| `@junto/overlay/renderer` | `surfaces` | `OverlaySurfaces` | `{}` |

The contract is `src/shared/overlay-contract.ts`. App code reads the decoded
manifest from `@shared/overlay` (`overlayManifest`) and renderer slots from
`src/renderer/overlay/surfaces.tsx` (`StoreSlot`, `hasStore`). Cosmetic packs
stay raw in the manifest; the portrait system decodes each one with
`src/shared/cosmetics/pack-schema.ts` and drops a bad pack alone. A pack may
keep bare keys (`keys: "bare"`: its items resolve by plain id, so looks saved
before an item moved keep resolving) and may declare the seat-identity draw
(`identity`): with it installed, seats are born from its lists; a drawn item
this install may not wear falls back to the open-source list with the same
roll. `brand.mascot` (name, seed, pinned traits) is read through
`@shared/brand` (`brandMascot`); without it the tour shows the plain mark.

Packaging reads the overlay's `brand/` directory (`scripts/overlay.ts
--brand-dir`): `brand/build/icon.icns` and `brand/build/dmg-background.png`
(macOS) and `brand/junto-icon.png` (Linux) replace this repository's neutral
ones in an official package.

Overlay files import app code through `@shared/*` and `@renderer/*`, and
packages (react, effect) resolve from this app's `node_modules`, so a build
has one copy of each.

## Build

```bash
# Open-source app
bun run app:build

# Official app
JUNTO_OVERLAY=../junto-premium bun run app:build
```

`app:build` prints the overlay it resolved (with the overlay commit) and fails
early on a path without `overlay/index.ts`.

## Gates

- `bun run lint:overlay`: overlay code is reached only through the alias.
- `bun run check:overlay-bundle` (after a build, also run by `verify` and
  `app:build`): an open-source `out/` carries no overlay marker but the
  stub's; an official one carries exactly one. With a premium checkout on the
  machine (`--premium DIR`, `JUNTO_PREMIUM`, or a sibling `../junto-premium`),
  it also fingerprints every premium item (its path data, or its id and name
  side by side) and the mascot, and fails if an open-source `out/` holds any.
