// Vellum Command-owned terminal contracts.
// Canvas stores stable bindings; runtime owns epochs/PTYs/presentation.
// Never put PIDs, sockets, tokens, scrollback, or engine handles in the document.

import { Schema } from "effect";
import { actorDeliverySurfaceOf } from "./actor-surface";
import type { CanvasNode, EtherHerdr, EtherTerminal, EtherTerminalLaunch, TerminalOnDelete } from "./canvas";
import { resolveHerdrOnDelete, resolveTerminalOnDelete } from "./canvas";

// Re-export canvas terminal schema pieces for runtime consumers.
export type { EtherTerminal, EtherTerminalLaunch, TerminalOnDelete } from "./canvas";
export { resolveTerminalOnDelete } from "./canvas";

/** Launch profile alias (document + runtime). */
export type TerminalLaunch = EtherTerminalLaunch;

// ── Runtime epoch (never in canvas) ───────────────────────────────────────

export const TerminalSessionStatus = Schema.Literals(["starting", "running",
"exited",
"missing",]);
export type TerminalSessionStatus = typeof TerminalSessionStatus.Type;

export const TerminalHarnessState = Schema.Literals(["idle", "working",
"blocked",
"attention",
"unknown",]);
export type TerminalHarnessState = typeof TerminalHarnessState.Type;

export const WorkSurfaceActivity = Schema.Struct({
  session: TerminalSessionStatus,
  harness: Schema.optionalKey(TerminalHarnessState),
  /**
   * Finished a turn, operator has not looked yet (seat idle + needsLook, herdr
   * "done"). Rides beside `harness: "idle"` rather than becoming a harness
   * state: ready asks for a glance, never for input, so needs-input surfaces
   * keep ignoring it while the region ladder can still show it.
   */
  ready: Schema.optionalKey(Schema.Boolean),
  source: Schema.optionalKey(Schema.Literals(["vellum-command", "herdr", "native"])),
});
export type WorkSurfaceActivity = typeof WorkSurfaceActivity.Type;

// ── Event journal (session authority → presentation) ──────────────────────

export const TerminalEventOutput = Schema.Struct({
  epoch: Schema.String,
  seq: Schema.BigInt,
  type: Schema.Literal("output"),
  /** Base64-encoded PTY bytes. */
  bytesBase64: Schema.String,
});
export type TerminalEventOutput = typeof TerminalEventOutput.Type;

export const TerminalEventResize = Schema.Struct({
  epoch: Schema.String,
  seq: Schema.BigInt,
  type: Schema.Literal("resize"),
  cols: Schema.Number,
  rows: Schema.Number,
});
export type TerminalEventResize = typeof TerminalEventResize.Type;

export const TerminalEventExit = Schema.Struct({
  epoch: Schema.String,
  seq: Schema.BigInt,
  type: Schema.Literal("exit"),
  code: Schema.optionalKey(Schema.Number),
  signal: Schema.optionalKey(Schema.String),
});
export type TerminalEventExit = typeof TerminalEventExit.Type;

export const TerminalEvent = Schema.Union([TerminalEventOutput,
TerminalEventResize,
TerminalEventExit,]);
export type TerminalEvent = typeof TerminalEvent.Type;

export const TerminalAttachSnapshot = Schema.Struct({
  epoch: Schema.String,
  snapshotAt: Schema.BigInt,
  /** Best-effort VT materialization (base64); may be empty. */
  checkpointBase64: Schema.optionalKey(Schema.String),
  tail: Schema.Array(TerminalEvent),
  cols: Schema.Number,
  rows: Schema.Number,
});
export type TerminalAttachSnapshot = typeof TerminalAttachSnapshot.Type;

// ── Capabilities (honest presentation) ────────────────────────────────────

export const TerminalCapabilities = Schema.Struct({
  mouse: Schema.Boolean,
  selectionNative: Schema.Boolean,
  ime: Schema.Boolean,
  graphics: Schema.Boolean,
  durable: Schema.Boolean,
  ownsKill: Schema.Boolean,
  presentation: Schema.Literals(["xterm", "herdr-stream"]),
});
export type TerminalCapabilities = typeof TerminalCapabilities.Type;

export const xtermCapabilities = (): TerminalCapabilities => ({
  mouse: true,
  selectionNative: true,
  ime: true,
  graphics: false,
  durable: false,
  ownsKill: true,
  presentation: "xterm",
});

export const herdrStreamCapabilities = (): TerminalCapabilities => ({
  mouse: false,
  selectionNative: false,
  ime: false,
  graphics: false,
  durable: true,
  ownsKill: false,
  presentation: "herdr-stream",
});

// ── Surface kinds ─────────────────────────────────────────────────────────

export type TerminalSurfaceKind = "native" | "herdr";

export type ResolvedTerminalBinding =
  | {
      readonly kind: "native";
      readonly hostId: string;
      readonly bindingId: string;
      readonly onDelete: TerminalOnDelete;
      readonly launch?: TerminalLaunch;
      readonly label?: string;
      /** Managed harness when authored via the picker. */
      readonly harness?: string;
      /** Agent key when the card is entity.kind agent. */
      readonly agentKey?: string;
    }
  | {
      readonly kind: "herdr";
      readonly hostId: string;
      readonly herdr: EtherHerdr;
      readonly onDelete: ReturnType<typeof resolveHerdrOnDelete>;
    };

/**
 * A herdr pane is geography: it renders and shows live state, but holds no
 * actor delivery surface. Its binding is read straight off the authored
 * `ether.herdr`, never through the actor sum.
 */
const herdrBinding = (
  node: CanvasNode,
): Extract<ResolvedTerminalBinding, { readonly kind: "herdr" }> | undefined => {
  if (node.ether?.entity?.kind !== "herdr") return undefined;
  const herdr = node.ether.herdr;
  if (!herdr || !herdr.terminalId?.trim()) return undefined;
  const herdrHost = herdr.host?.trim();
  const nodeHost = typeof node.ether.host === "string" ? node.ether.host.trim() : "";
  return {
    kind: "herdr",
    hostId:
      herdrHost && herdrHost.length > 0
        ? herdrHost
        : nodeHost.length > 0
          ? nodeHost
          : "local",
    herdr,
    onDelete: resolveHerdrOnDelete(herdr),
  };
};

/**
 * A raw user-opened terminal: geography, not an actor. It hosts a PTY and
 * renders like any terminal, but holds no seat, no harness, and no inbox —
 * which is exactly why it resolves here and not through the actor surface.
 */
const rawTerminalBinding = (node: CanvasNode): ResolvedTerminalBinding | undefined => {
  if (node.ether?.entity?.kind !== "terminal") return undefined;
  const bindingId = node.ether.terminal?.bindingId?.trim();
  // Partially authored terminal (no binding yet) — nothing to attach to.
  if (!bindingId) return undefined;
  const nodeHost = typeof node.ether.host === "string" ? node.ether.host.trim() : "";
  return {
    kind: "native",
    hostId: nodeHost.length > 0 ? nodeHost : "local",
    bindingId,
    onDelete: resolveTerminalOnDelete(node.ether.terminal),
    launch: node.ether.terminal?.launch as TerminalLaunch | undefined,
    label: node.ether.terminal?.label,
  };
};

/**
 * Resolve a canvas node to a terminal surface binding: the two geography panes
 * (herdr, raw terminal) first, then the one actor seat. No "if terminal OR
 * agent OR acp".
 */
export const resolveTerminalBinding = (
  node: CanvasNode,
): ResolvedTerminalBinding | undefined => {
  const herdr = herdrBinding(node);
  if (herdr) return herdr;

  const raw = rawTerminalBinding(node);
  if (raw) return raw;

  const surface = actorDeliverySurfaceOf(node);
  if (!surface) return undefined;
  return {
    kind: "native",
    hostId: surface.hostId,
    bindingId: surface.bindingId,
    onDelete: resolveTerminalOnDelete(node.ether?.terminal),
    launch: surface.launch as TerminalLaunch | undefined,
    label: node.ether?.terminal?.label,
    harness: surface.harness,
    agentKey: surface.agentKey,
  };
};

export const isTerminalNode = (node: CanvasNode): boolean =>
  resolveTerminalBinding(node) !== undefined;

/** Runtime summary for inventory / quit dialog (never canvas). */
export type TerminalSessionSummary = {
  readonly bindingId: string;
  readonly epoch: string;
  readonly hostId: string;
  readonly status: TerminalSessionStatus;
  /**
   * Process termination was requested and interaction authority is revoked,
   * but the exact exit witness has not settled yet.
   */
  readonly stopping?: true;
  readonly title?: string;
  /**
   * Best-effort live process label for canvas chrome: OSC window title when
   * the harness sets one, else spawn argv basename. Never required for
   * correctness — display only.
   */
  readonly processName?: string;
  readonly cwd?: string;
  readonly pid?: number;
  readonly detached: boolean;
  readonly canvasName?: string;
  readonly nodeId?: string;
  readonly createdAt: number;
  readonly label?: string;
  /** Runtime backend; production admits only the native PTY path. */
  readonly backend?: "pty";
  /**
   * Pre-ownership failure class. Absent on clean post-run exits.
   * `cli-missing` is distinct from idle "stopped" on the canvas.
   */
  readonly exitReason?: "cli-missing" | "spawn_failed";
  /** Operator-facing explanation when `exitReason` is set. */
  readonly exitMessage?: string;
  /** Actor identity stamped when this generation was occupied as a seat. */
  readonly harness?: string;
  readonly agentKey?: string;
};

/** True when a hop/get reply bound the actor we asked Mini to occupy. */
export const sessionActorMatches = (
  summary: Pick<TerminalSessionSummary, "harness" | "agentKey"> | undefined,
  actor: { readonly harness: string; readonly agentKey: string },
): boolean =>
  summary?.harness === actor.harness && summary?.agentKey === actor.agentKey;
