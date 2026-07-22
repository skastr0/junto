// Vellum-owned terminal contracts.
// Canvas stores stable bindings; runtime owns epochs/PTYs/presentation.
// Never put PIDs, sockets, tokens, scrollback, or engine handles in the document.

import { Schema } from "effect";
import type { CanvasNode, EtherHerdr, EtherTerminal, EtherTerminalLaunch, TerminalOnDelete } from "./canvas";
import { resolveHerdrOnDelete, resolveTerminalOnDelete } from "./canvas";

// Re-export canvas terminal schema pieces for runtime consumers.
export type { EtherTerminal, EtherTerminalLaunch, TerminalOnDelete } from "./canvas";
export { resolveTerminalOnDelete } from "./canvas";

/** Launch profile alias (document + runtime). */
export type TerminalLaunch = EtherTerminalLaunch;

// ── Runtime epoch (never in canvas) ───────────────────────────────────────

export const TerminalSessionStatus = Schema.Literal(
  "starting",
  "running",
  "exited",
  "missing",
);
export type TerminalSessionStatus = typeof TerminalSessionStatus.Type;

export const TerminalHarnessState = Schema.Literal(
  "idle",
  "working",
  "blocked",
  "attention",
  "unknown",
);
export type TerminalHarnessState = typeof TerminalHarnessState.Type;

export const WorkSurfaceActivity = Schema.Struct({
  session: TerminalSessionStatus,
  harness: Schema.optionalWith(TerminalHarnessState, { exact: true }),
  source: Schema.optionalWith(Schema.Literal("vellum-cli", "herdr", "native"), {
    exact: true,
  }),
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
  code: Schema.optionalWith(Schema.Number, { exact: true }),
  signal: Schema.optionalWith(Schema.String, { exact: true }),
});
export type TerminalEventExit = typeof TerminalEventExit.Type;

export const TerminalEvent = Schema.Union(
  TerminalEventOutput,
  TerminalEventResize,
  TerminalEventExit,
);
export type TerminalEvent = typeof TerminalEvent.Type;

export const TerminalAttachSnapshot = Schema.Struct({
  epoch: Schema.String,
  snapshotAt: Schema.BigInt,
  /** Best-effort VT materialization (base64); may be empty. */
  checkpointBase64: Schema.optionalWith(Schema.String, { exact: true }),
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
  presentation: Schema.Literal("ghostty", "xterm", "herdr-stream"),
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

export const ghosttyCapabilities = (): TerminalCapabilities => ({
  mouse: true,
  selectionNative: true,
  ime: true,
  graphics: true,
  durable: false,
  ownsKill: true,
  presentation: "ghostty",
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
    }
  | {
      readonly kind: "herdr";
      readonly hostId: string;
      readonly herdr: EtherHerdr;
      readonly onDelete: ReturnType<typeof resolveHerdrOnDelete>;
    };

/**
 * Resolve a canvas node to a terminal surface binding.
 * Native `ether.terminal` wins when present with entity.kind terminal.
 * Legacy herdr nodes remain a separate document form.
 */
export const resolveTerminalBinding = (
  node: CanvasNode,
): ResolvedTerminalBinding | undefined => {
  const ether = node.ether;
  if (!ether) return undefined;
  const entityKind = ether.entity?.kind;

  if (entityKind === "terminal" || ether.terminal) {
    const t = ether.terminal as EtherTerminal | undefined;
    const bindingId = t?.bindingId?.trim();
    if (!bindingId) {
      // Partially authored terminal node — still native-shaped when kind says so.
      if (entityKind !== "terminal") return undefined;
      return undefined;
    }
    const hostId =
      (typeof ether.host === "string" && ether.host.length > 0
        ? ether.host
        : undefined) ?? "local";
    return {
      kind: "native",
      hostId,
      bindingId,
      onDelete: resolveTerminalOnDelete(t),
      launch: t?.launch,
      label: t?.label,
    };
  }

  if (entityKind === "herdr" || ether.herdr) {
    const herdr = ether.herdr;
    if (!herdr) return undefined;
    const hostId =
      (typeof herdr.host === "string" && herdr.host.length > 0
        ? herdr.host
        : typeof ether.host === "string" && ether.host.length > 0
          ? ether.host
          : "local");
    return {
      kind: "herdr",
      hostId,
      herdr,
      onDelete: resolveHerdrOnDelete(herdr),
    };
  }

  return undefined;
};

export const isTerminalNode = (node: CanvasNode): boolean =>
  resolveTerminalBinding(node) !== undefined ||
  node.ether?.entity?.kind === "terminal" ||
  node.ether?.entity?.kind === "herdr";

/** Runtime summary for inventory / quit dialog (never canvas). */
export type TerminalSessionSummary = {
  readonly bindingId: string;
  readonly epoch: string;
  readonly hostId: string;
  readonly status: TerminalSessionStatus;
  readonly title?: string;
  readonly cwd?: string;
  readonly pid?: number;
  readonly detached: boolean;
  readonly canvasName?: string;
  readonly nodeId?: string;
  readonly createdAt: number;
  readonly label?: string;
};
