import type { Node, Wire } from "./model";

// Demo/scripting engine contracts. The engine exists ONLY when the app is
// launched with --junto-demo (argv) or JUNTO_DEMO=1 (env): outside demo
// mode every channel below answers inert ({ active: false } / ok:false) and
// no scripted transport is ever constructed. Nothing here is product
// behavior — it is a film set for driving the real UI deterministically.
//
// Clock model: ONE conductor (renderer) owns musical time. A scenario is a
// beat-indexed op list at a fixed BPM; the conductor schedules ops against
// performance.now() and drives the real UI unchanged.

/** Milliseconds per beat at a given tempo. */
export const beatMs = (bpm: number): number => 60_000 / bpm;


// --- scenario ---------------------------------------------------------------

export interface DemoScenario {
  readonly id: string;
  readonly title: string;
  readonly bpm: number;
  readonly beats: ReadonlyArray<DemoBeat>;
}

export interface DemoBeat {
  /** Musical position in beats from take start. Fractional = subdivisions. */
  readonly at: number;
  readonly ops: ReadonlyArray<DemoOp>;
}

export type DemoOp =
  | { readonly kind: "add-nodes"; readonly nodes: ReadonlyArray<Node> }
  | { readonly kind: "add-edges"; readonly edges: ReadonlyArray<Wire> }
  | { readonly kind: "remove-nodes"; readonly ids: ReadonlyArray<string> }
  | { readonly kind: "select"; readonly nodeIds: ReadonlyArray<string> }
  | {
      readonly kind: "camera-fit";
      /** Absent = fit everything currently on the canvas. */
      readonly nodeIds?: ReadonlyArray<string>;
      readonly durationBeats: number;
      readonly padding?: number;
      readonly maxZoom?: number;
    }
  | {
      readonly kind: "camera-center";
      readonly x: number;
      readonly y: number;
      readonly zoom?: number;
      readonly durationBeats: number;
    }
  | { readonly kind: "sfx"; readonly id: string }
  | { readonly kind: "hud"; readonly show: boolean }
  | {
      /** Animated position moves (React Flow is driven directly during the
       * tween; one native Move persists the end). */
      readonly kind: "tween-nodes";
      readonly moves: ReadonlyArray<{ readonly id: string; readonly x: number; readonly y: number }>;
      readonly durationBeats: number;
      readonly easing?: "linear" | "in-out";
    }
  /** Product Space-cycle: jump camera to the next alerted node (plays its own sfx). */
  | { readonly kind: "alert-cycle" }
  /** Opens the real browser surface (WebContentsView) for a page node. */
  | { readonly kind: "page-open"; readonly nodeId: string };

// The state, the EDL (edit decision list) and its write are the window's
// demo group: src/contract/window/demo.ts.
