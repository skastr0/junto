import { ulid } from "ulid";
import type {
  EtherBrowser,
  EtherTerminalLaunch,
  FileNode,
  GroupNode,
  LinkNode,
  TextNode,
} from "@shared/canvas";
import type { HarnessId } from "@shared/managed-terminal-templates";
import { templateFor } from "@shared/managed-terminal-templates";
import {
  ARTIFACTS_ENABLED,
  BOARD_ENABLED,
  managedHarnessEnabled,
  PAD_ENABLED,
  REQUESTS_ENABLED,
  SHEET_ENABLED,
  TASKS_ENABLED,
} from "@shared/features";
import { resolveManagedLaunch } from "@shared/managed-terminal-launch";
import { emptySheet } from "@shared/sheet";
import { isValidStationHostId } from "@shared/station";
import { AGENT_NODE_SIZE } from "./node-geometry";

const requireHostId = (value: string): string => {
  const host = value.trim();
  if (!isValidStationHostId(host)) {
    throw new Error(`invalid station host id: ${JSON.stringify(value)}`);
  }
  return host;
};

export const makeTextNode = (x: number, y: number): TextNode => ({
  id: `node-${ulid()}`,
  type: "text",
  text: "new note",
  x: Math.round(x),
  y: Math.round(y),
  width: 240,
  height: 100,
});

/**
 * Geography label — bare map text (no card chrome, no connectors).
 * Settings surface: text + optional color + size. Not a crew seat.
 */
export const makeLabelNode = (x: number, y: number): TextNode => ({
  id: `label-${ulid()}`,
  type: "text",
  text: "Label",
  x: Math.round(x),
  y: Math.round(y),
  width: 160,
  height: 40,
  ether: {
    entity: { kind: "label" },
  },
});

/**
 * Geography image card — JSON Canvas `file` node whose `file` is a
 * `junto-content://` object URL for an image ContentRef. Renders the image;
 * no crew ports. Plain workspace-path file cards are retired.
 */
export const makeImageNode = (
  x: number,
  y: number,
  contentFileUrl: string,
  size?: { readonly width: number; readonly height: number },
): FileNode => ({
  id: `image-${ulid()}`,
  type: "file",
  file: contentFileUrl,
  x: Math.round(x),
  y: Math.round(y),
  width: Math.round(size?.width ?? 280),
  height: Math.round(size?.height ?? 200),
});

export const makeGroupNode = (
  x: number,
  y: number,
  size?: { readonly width: number; readonly height: number },
): GroupNode => ({
  id: `region-${ulid()}`,
  type: "group",
  label: "new region",
  x: Math.round(x),
  y: Math.round(y),
  width: Math.round(size?.width ?? 560),
  height: Math.round(size?.height ?? 320),
});

/**
 * Authoring constructor gate: a feature-off sink cannot be created by any
 * code path, while an already-authored node still decodes and renders.
 */
const requireFeature = (enabled: boolean, label: string): void => {
  if (!enabled) throw new Error(`${label} is disabled in this build`);
};

/** Shared options for authoring or re-seating a managed agent. */
export type ManagedAgentSeatOptions = {
  readonly harness: HarnessId;
  /** Enrolled HostId used for placement and Station projection. */
  readonly host: string;
  /** Hermes routing prefix when the enrolled host declares a distinct key. */
  readonly agentHost?: string;
  readonly profile?: string;
  readonly model?: string;
  readonly effort?: string;
  /** Named agent mode (Amp `-m low|medium|high|ultra`). */
  readonly mode?: string;
  readonly permissionMode?: string;
  readonly cwd?: string;
  readonly label?: string;
};

export type ManagedAgentSeatFields = {
  readonly text: string;
  readonly ether: NonNullable<TextNode["ether"]>;
};

/**
 * Pure seat fields (label + ether) for a managed agent.
 * Shared by node creation and re-seat — one place for harness launch rules.
 * Kind `agent` ⇒ entity.name + terminal.bindingId + terminal.harness.
 * Secrets never stored in launch.env.
 */
export const buildManagedAgentSeat = (
  options: ManagedAgentSeatOptions,
): ManagedAgentSeatFields => {
  if (!managedHarnessEnabled(options.harness)) {
    throw new Error(`managed harness ${options.harness} is disabled in this build`);
  }
  const host = requireHostId(options.host);
  const agentHost = requireHostId(options.agentHost ?? host);
  const template = templateFor(options.harness);
  // Document launch: argv only — main injects scrubbed seat env at spawn.
  const full = resolveManagedLaunch(
    options.harness,
    {
      ...(options.profile ? { profile: options.profile } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.effort ? { effort: options.effort } : {}),
      ...(options.mode ? { mode: options.mode } : {}),
      ...(options.permissionMode
        ? { permissionMode: options.permissionMode }
        : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
      injection: { seatBound: false, connected: false },
    },
    {},
  );
  const launch: EtherTerminalLaunch = {
    kind: "harness",
    argv: full.argv,
    ...(full.cwd ? { cwd: full.cwd } : {}),
  };
  const agentKey =
    options.harness === "hermes" && options.profile
      ? `${agentHost}:${options.profile}`
      : `${agentHost}:${options.harness}`;
  const parts = [
    template.displayName,
    options.profile,
    options.model,
    options.effort,
    options.mode,
  ].filter((p): p is string => Boolean(p && p.trim()));
  const label = options.label?.trim() || parts.join(" - ");
  // Pin harnesses (Claude/Grok/Pi/Cursor) require a UUID for their session-id
  // flag; ULIDs are rejected. The id is minted here, before the seat exists, so
  // the node knows its session from the first spawn and every later wake
  // resumes that exact one.
  const pinSession =
    template.capabilityBadges.sessionId === "pin"
      ? crypto.randomUUID()
      : undefined;
  // Re-resolve argv with session pin when supported.
  const launchWithSession: EtherTerminalLaunch = pinSession
    ? (() => {
        const pinned = resolveManagedLaunch(
          options.harness,
          {
            ...(options.profile ? { profile: options.profile } : {}),
            ...(options.model ? { model: options.model } : {}),
            ...(options.effort ? { effort: options.effort } : {}),
            ...(options.mode ? { mode: options.mode } : {}),
            ...(options.permissionMode
              ? { permissionMode: options.permissionMode }
              : {}),
            ...(options.cwd ? { cwd: options.cwd } : {}),
            sessionId: pinSession,
            injection: { seatBound: false, connected: false },
          },
          {},
        );
        return {
          kind: "harness" as const,
          argv: pinned.argv,
          ...(pinned.cwd ? { cwd: pinned.cwd } : {}),
        };
      })()
    : launch;
  return {
    text: label,
    ether: {
      entity: { kind: "agent", name: agentKey },
      host,
      terminal: {
        bindingId: ulid(),
        label,
        harness: options.harness,
        launch: launchWithSession,
        ...(pinSession ? { sessionId: pinSession } : {}),
      },
    },
  };
};

/**
 * Managed-terminal actor seat — the only legal agent authoring form.
 * Opens via managed terminal (not ACP).
 */
export const makeManagedAgentNode = (
  x: number,
  y: number,
  options: ManagedAgentSeatOptions,
): TextNode => {
  const seat = buildManagedAgentSeat(options);
  return {
    id: `agent-${ulid()}`,
    type: "text",
    text: seat.text,
    x: Math.round(x),
    y: Math.round(y),
    width: AGENT_NODE_SIZE.width,
    height: AGENT_NODE_SIZE.height,
    ether: seat.ether,
  };
};

/**
 * Re-seat an existing agent node onto a new harness (new binding + launch).
 * Preserves id, geometry, and flags; mints a fresh bindingId so the old
 * process can be killed without colliding with the new seat.
 */
export const reseatManagedAgentNode = (
  node: TextNode,
  options: Omit<ManagedAgentSeatOptions, "host"> & {
    readonly host?: string;
  },
): TextNode => {
  if (node.ether?.entity?.kind !== "agent") {
    throw new Error("reseatManagedAgentNode requires an agent node");
  }
  const host =
    options.host?.trim() ||
    (typeof node.ether.host === "string" && node.ether.host.trim().length > 0
      ? node.ether.host
      : "local");
  const seat = buildManagedAgentSeat({ ...options, host });
  const flags = node.ether.flags;
  return {
    ...node,
    text: seat.text,
    ether: {
      ...seat.ether,
      ...(flags && flags.length > 0 ? { flags } : {}),
    },
  };
};

// A tasks node — task list; blocks only when edged with criteria.mode tasks.
export const makeTasksNode = (
  x: number,
  y: number,
  queueHost: string,
): TextNode => {
  requireFeature(TASKS_ENABLED, "tasks sink");
  const host = requireHostId(queueHost);
  return {
    id: `task-${ulid()}`,
    type: "text",
    text: "tasks",
    x: Math.round(x),
    y: Math.round(y),
    width: 240,
    height: 120,
    ether: {
      entity: { kind: "task" },
      host,
      tasks: { items: [] },
    },
  };
};

// Operator requests — items live around state input-required.
export const makeRequestsNode = (x: number, y: number): TextNode => {
  requireFeature(REQUESTS_ENABLED, "requests sink");
  return {
    id: `requests-${ulid()}`,
    type: "text",
    text: "requests",
    x: Math.round(x),
    y: Math.round(y),
    width: 240,
    height: 120,
    ether: {
      entity: { kind: "requests" },
      requests: { items: [] },
    },
  };
};

// Artifact shelf — published parts with optional task provenance.
export const makeArtifactsNode = (x: number, y: number): TextNode => {
  requireFeature(ARTIFACTS_ENABLED, "artifacts sink");
  return {
    id: `artifacts-${ulid()}`,
    type: "text",
    text: "artifacts",
    x: Math.round(x),
    y: Math.round(y),
    width: 240,
    height: 120,
    ether: {
      entity: { kind: "artifacts" },
      artifacts: { items: [] },
    },
  };
};

/** Bulletin board sink — topics + posts; work-plane owns durability. */
export const makeBoardNode = (x: number, y: number): TextNode => {
  requireFeature(BOARD_ENABLED, "board sink");
  return {
    id: `board-${ulid()}`,
    type: "text",
    text: "board",
    x: Math.round(x),
    y: Math.round(y),
    width: 240,
    height: 120,
    ether: {
      entity: { kind: "board" },
      board: { topics: [] },
    },
  };
};

/** Sheet sink — the grid is authored on the node, so it is born with one. */
export const makeSheetNode = (x: number, y: number): TextNode => {
  requireFeature(SHEET_ENABLED, "sheet sink");
  return {
    id: `sheet-${ulid()}`,
    type: "text",
    text: "sheet",
    x: Math.round(x),
    y: Math.round(y),
    width: 260,
    height: 120,
    ether: {
      entity: { kind: "sheet" },
      sheet: emptySheet(),
    },
  };
};

/** Spatial pad sink — empty is legal; work-plane owns durability. */
export const makePadNode = (x: number, y: number): TextNode => {
  requireFeature(PAD_ENABLED, "pad sink");
  return {
    id: `pad-${ulid()}`,
    type: "text",
    text: "pad",
    x: Math.round(x),
    y: Math.round(y),
    width: 240,
    height: 120,
    ether: {
      entity: { kind: "pad" },
    },
  };
};


/** Junto-owned terminal node. Session starts on create / open (no card Start). */
export const makeTerminalNode = (
  x: number,
  y: number,
  launch?: EtherTerminalLaunch,
  label = "terminal",
  host = "local",
): TextNode => ({
  id: `terminal-${ulid()}`,
  type: "text",
  text: label,
  x: Math.round(x),
  y: Math.round(y),
  width: 260,
  height: 110,
  ether: {
    entity: { kind: "terminal" },
    host,
    terminal: { bindingId: ulid(), label, ...(launch ? { launch } : {}) },
  },
});

// A browser page work-surface node — JSON Canvas `link` + ether.browser.
// Profile name only in the document; cookies stay in the browser runtime.
// Not an EntitySource; not a pulse target; not blockable.
// Plain link furniture (url-only cards) is retired — pages are authored here only.
export const makePageNode = (
  x: number,
  y: number,
  url: string,
  browser?: Partial<EtherBrowser>,
  host = "local",
): LinkNode => {
  const profile = browser?.profile?.trim() || "personal";
  return {
    id: `page-${ulid()}`,
    type: "link",
    url,
    x: Math.round(x),
    y: Math.round(y),
    width: 260,
    height: 110,
    ether: {
      entity: { kind: "page" },
      host,
      browser: {
        profile,
        onDelete: browser?.onDelete ?? "kill-session",
      },
    },
  };
};

/**
 * Gauge (watcher) — hermes stat_threshold stub. Product-hidden from palette.
 * Hermes is agent fleet join, not this product’s external automation sensor.
 * Existing boards still decode. Future external-input actuator (webhook/poll)
 * is a new surface — do not “revive” this hermes gauge as that story.
 */
export const makeGaugeNode = (
  x: number,
  y: number,
  host = "local",
): TextNode => ({
  id: `watch-${ulid()}`,
  type: "text",
  text: "gauge",
  x: Math.round(x),
  y: Math.round(y),
  width: 220,
  height: 96,
  ether: {
    entity: { kind: "watcher" },
    host,
    watch: { kind: "stat_threshold", source: "hermes" },
  },
});

/** Git commit browser — geography furniture. Live status is IPC, not document. */
export const makeGitNode = (
  x: number,
  y: number,
  cwd: string,
  label = "git",
): TextNode => ({
  id: `git-${ulid()}`,
  type: "text",
  text: label,
  x: Math.round(x),
  y: Math.round(y),
  width: 280,
  height: 128,
  ether: {
    entity: { kind: "git" },
    git: { cwd },
  },
});

/** Cron schedule node — 5-field expression; fires edge effects on due. */
export const makeCronNode = (
  x: number,
  y: number,
  expression = "*/30 * * * *",
  host = "local",
): TextNode => ({
  id: `cron-${ulid()}`,
  type: "text",
  text: "cron",
  x: Math.round(x),
  y: Math.round(y),
  width: 220,
  height: 96,
  ether: {
    entity: { kind: "cron" },
    host,
    timer: { expression, everyMinutes: 30 },
  },
});

/**
 * Relay — product canvas-state sensor (peer of cron).
 * Binding is the wire: draw sink → relay (when) and relay → target (does).
 */
export const makeRelayNode = (
  x: number,
  y: number,
  host = "local",
): TextNode => ({
  id: `relay-${ulid()}`,
  type: "text",
  text: "relay",
  x: Math.round(x),
  y: Math.round(y),
  width: 220,
  height: 96,
  ether: {
    entity: { kind: "relay" },
    host,
  },
});
