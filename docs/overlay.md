# Build-time overlay

This repository builds the complete open-source Junto app. The official build
adds premium commercial content (the store and purchase delivery surface, and
the premium items of the Junto cast) from a private overlay repository, **at
build time**. Nothing premium is read from disk at run time; it is compiled
into the bundle. A fork that builds this repository gets no store and no
premium items, by design.

There is one Junto cast, and Pip and the brand cast belong to it: they, the
portrait engine and editor, the pack format, and every brand surface (app
icon, DMG, tour guide) are in this repository. Free vs premium is only which
items are unlocked. The free items (`src/shared/cosmetics/base-pack.ts`) are
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
  side by side) and fails if an open-source `out/` holds any. Pip and the
  brand cast are open source and not fingerprinted.
