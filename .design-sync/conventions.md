# Vellum Command — how to build with this design system

**This library is a seed, not a museum.** The token language below is binding — the palette, the elevation and ink ladders, the type system. The component implementations are the app's *current state*, imported so you can refine them: iterate boldly on composition, spacing, and structure, but stay inside the token language. Do not pixel-match the current components when a better design serves the same intent.

## The canvas ground (non-negotiables)

- Two modes, one language: `dark` (default) and `bright` ride the same tokens via `html[data-theme="bright"]`; tokens come from `src/shared/theme/` through `bun run theme:build`. The ground is never pure black, never pure white — the field is `--color-ground`.
- Amber is home: roughly 95% of accent usage is amber; the other hues are sparse punctuation.
- **Crimson is reserved for blockers** — never decorative, never a generic "error red" wash.
- Type is a mono instrument (`--font-mono`, SF Mono stack) with a condensed display stamp (`--font-display`, Arial Narrow stack) for eyebrows/stamps. Uppercase + wide tracking for labels and eyebrows.

## Tokens (sourced in src/shared/theme/, projected to src/renderer/styles/theme.generated.css)

- Elevation ladder: `--color-ground` (field) → `--color-raise` (cards/panels) → `--color-raise-2` (panel header strips) → `--color-inset` (sunken inputs, toolbar pills) → `--color-well` (deepest, code blocks).
- Ink ladder: `--color-ink` (primary text) → `--color-ink-2` (secondary) → `--color-dim` (meta) → `--color-faint` (eyebrows, placeholders).
- House hues: `--color-amber`, `--color-amber-hi` (lit amber for primary-action text), `--color-cyan`, `--color-violet`, `--color-crimson` (blockers only), `--color-steel`, `--color-indigo`, `--color-green` (health ok).
- Strokes are ink at low alpha, never greys: `--color-stroke`, `--color-stroke-hi`.

Tailwind utilities generated from these tokens (`bg-ground`, `bg-raise`, `text-ink`, `text-dim`, `text-amber`, `border-stroke`, …) work **only for class names the app already uses** — the shipped stylesheet is the app's compiled set. When a utility has no effect, use inline styles with the `var(--color-*)` tokens instead; that always works.

## Composing

- Wrap nothing: components render standalone — no provider is required.
- **Canvas nodes are the exception**: `NodeShell`, `TextNode`, `FileNode`, `LinkNode`, `GroupNode` are React Flow node renderers. Stage them through `CanvasStage` (exported from this library) — never import React Flow yourself:

```jsx
import { CanvasStage, TextNode, Button, Chip } from "@skastr0/vellum";

<CanvasStage
  height={320}
  nodeTypes={{ text: TextNode }}
  nodes={[{
    id: "n1", type: "text", position: { x: 0, y: 0 }, width: 260, height: 120,
    data: { node: { id: "n1", type: "text", text: "Stage the release build.", x: 0, y: 0, width: 260, height: 120 }, blocked: false },
  }]}
/>
```

- **Store-fed surfaces need seeding**: `InspectorPanel`, `EdgeCommandCard`, `StoppageRank`, `KindStrip`, `KindSurface`, `NodeCapabilityInventory`, and the edge toggles read the app's canvas document from a global store and render empty (or nothing) without it. Wrap them in `SeedState` (exported from this library) and pass a canvas doc + selection:

```jsx
import { SeedState, InspectorPanel } from "@skastr0/vellum";

<SeedState
  doc={{ nodes: [{ id: "a1", type: "text", text: "research agent", x: 0, y: 0, width: 240, height: 120, ether: { entity: { kind: "agent" } } }], edges: [] }}
  selectedNodeId="a1"
>
  <InspectorPanel />
</SeedState>
```

  Prefer the prop-driven editors (`NodeFieldEditors`, `NodeFlagControls`, `NodePlacementSection`, `ConnectEditor`, the Region editors) when you control the data directly.
- One amber `primary` action per surface (never two); `chrome` is the default button; `subtle` for quiet actions; `danger` sparingly.
- Per-component API contracts are in each component's `.d.ts`; usage notes in its `.prompt.md`.

## Where truth lives

`styles.css` (tokens + compiled utilities + component CSS via its imports) · `components/<group>/<Name>/<Name>.d.ts` (props) · `components/<group>/<Name>/<Name>.prompt.md` (usage).
