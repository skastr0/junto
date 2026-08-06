import type { CanvasEdge, CanvasNode, EtherFlag } from "./canvas";

// Demo/scripting engine contracts. The engine exists ONLY when the app is
// launched with --vellum-demo (argv) or VELLUM_COMMAND_DEMO=1 (env): outside demo
// mode every channel below answers inert ({ active: false } / ok:false) and
// no scripted transport is ever constructed. Nothing here is product
// behavior — it is a film set for driving the real UI deterministically.
//
// Clock model: ONE conductor (renderer) owns musical time. A scenario is a
// beat-indexed op list at a fixed BPM; the conductor schedules ops against
// performance.now() and drives main-side herdr state over IPC so the real
// mirror -> IPC -> renderer pipeline runs unchanged.

export const DEMO_BPM_DEFAULT = 110;

/** Milliseconds per beat at a given tempo. */
export const beatMs = (bpm: number): number => 60_000 / bpm;

export type DemoHerdrStatus = "idle" | "working" | "blocked" | "done";

export interface DemoHerdrPaneSpec {
  readonly host: string;
  readonly paneId: string;
  /** Harness name rendered on the card (claude | codex | kimi | ...). */
  readonly agent: string;
  readonly cwd?: string;
  readonly label?: string;
}

/** Conductor -> main mutations of the scripted herdr world. */
export type DemoCommand =
  | {
      readonly kind: "ensure-pane";
      readonly pane: DemoHerdrPaneSpec;
      readonly status?: DemoHerdrStatus;
    }
  | {
      readonly kind: "set-status";
      readonly host: string;
      readonly paneId: string;
      readonly status: DemoHerdrStatus;
    }
  | { readonly kind: "reset-host"; readonly host: string };

export interface DemoCommandResult {
  readonly ok: boolean;
  readonly error?: string;
}

export interface DemoStateInfo {
  readonly active: boolean;
  /** VELLUM_COMMAND_DEMO_AUTOROLL=1 — the take starts itself shortly after mount
   * (headless/scripted capture; also dodges any pre-mount beat-0 race). */
  readonly autoroll?: boolean;
  /** VELLUM_COMMAND_DEMO_SCENARIO — scenario id to roll (F9 and autoroll). Unknown or
   * absent falls back to the default scenario in the renderer registry. */
  readonly scenarioId?: string;
}

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
  | { readonly kind: "add-nodes"; readonly nodes: ReadonlyArray<CanvasNode> }
  | { readonly kind: "add-edges"; readonly edges: ReadonlyArray<CanvasEdge> }
  | { readonly kind: "remove-nodes"; readonly ids: ReadonlyArray<string> }
  | {
      readonly kind: "flag";
      readonly nodeIds: ReadonlyArray<string>;
      readonly flag: EtherFlag;
      readonly on: boolean;
    }
  | { readonly kind: "select"; readonly nodeIds: ReadonlyArray<string> }
  | { readonly kind: "herdr"; readonly command: DemoCommand }
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
       * tween; the document reconciles once at the end). */
      readonly kind: "tween-nodes";
      readonly moves: ReadonlyArray<{ readonly id: string; readonly x: number; readonly y: number }>;
      readonly durationBeats: number;
      readonly easing?: "linear" | "in-out";
    }
  /** Product Space-cycle: jump camera to the next alerted node (plays its own sfx). */
  | { readonly kind: "alert-cycle" }
  /** Opens the herdr terminal modal on a node. CAMEO ONLY: the stream path
   * execs the real herdr binary, so use exclusively on nodes bound to REAL
   * panes — never on scripted/synthetic ones. */
  | { readonly kind: "open-terminal"; readonly nodeId: string }
  | { readonly kind: "close-terminal" }
  /** Opens the real browser surface (WebContentsView) for a page node. */
  | { readonly kind: "page-open"; readonly nodeId: string };

// --- EDL (edit decision list) ------------------------------------------------
// The conductor logs every executed op with planned vs actual time so post
// (music sync, overlays, cuts) is computed from data, never hand-timed.

export interface DemoEdlEntry {
  readonly beat: number;
  readonly plannedMs: number;
  readonly actualMs: number;
  /** Compact op tag, e.g. "add-nodes:12" or "herdr:set-status:h07:blocked". */
  readonly op: string;
}

export interface DemoEdl {
  readonly scenarioId: string;
  readonly bpm: number;
  readonly startedAtEpochMs: number;
  readonly entries: ReadonlyArray<DemoEdlEntry>;
}

export interface DemoWriteEdlResult {
  readonly ok: boolean;
  readonly path?: string;
  readonly error?: string;
}
