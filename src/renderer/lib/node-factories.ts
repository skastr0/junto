import { ulid } from "ulid";
import type {
  EtherBrowser,
  EtherHerdr,
  EtherTerminalLaunch,
  FileNode,
  GroupNode,
  LinkNode,
  TextNode,
} from "@shared/canvas";
import type { HarnessId } from "@shared/managed-terminal-templates";
import { templateFor } from "@shared/managed-terminal-templates";
import { resolveManagedLaunch } from "@shared/managed-terminal-launch";
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
 * Settings surface: text + optional color + size. Not a factory seat.
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
 * `vellum-content://` object URL for an image ContentRef. Renders the image;
 * no factory ports. Plain workspace-path file cards are retired.
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
 * Managed-terminal actor seat — the only legal agent authoring form.
 * Kind `agent` ⇒ required ports: entity.name + terminal.bindingId + terminal.harness.
 * Opens via managed terminal (not ACP). Secrets never stored in launch.env.
 */
export const makeManagedAgentNode = (
  x: number,
  y: number,
  options: {
    readonly harness: HarnessId;
    /** Enrolled HostId used for placement and Station projection. */
    readonly host: string;
    /** Hermes routing prefix when the enrolled host declares a distinct key. */
    readonly agentHost?: string;
    readonly profile?: string;
    readonly model?: string;
    readonly effort?: string;
    readonly cwd?: string;
    readonly label?: string;
  },
): TextNode => {
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
      ...(options.cwd ? { cwd: options.cwd } : {}),
      injection: { connected: false },
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
  ].filter((p): p is string => Boolean(p && p.trim()));
  const label = options.label?.trim() || parts.join(" - ");
  // Pin harnesses (Claude/Grok) require a UUID for --session-id; ULIDs are rejected.
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
            ...(options.cwd ? { cwd: options.cwd } : {}),
            sessionId: pinSession,
            injection: { connected: false },
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
    id: `agent-${ulid()}`,
    type: "text",
    text: label,
    x: Math.round(x),
    y: Math.round(y),
    width: AGENT_NODE_SIZE.width,
    height: AGENT_NODE_SIZE.height,
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

// A tasks node — task list; blocks only when edged with criteria.mode tasks.
export const makeTasksNode = (
  x: number,
  y: number,
  queueHost: string,
): TextNode => {
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
export const makeRequestsNode = (x: number, y: number): TextNode => ({
  id: `requests-${ulid()}`,
  type: "text",
  text: "0 pending",
  x: Math.round(x),
  y: Math.round(y),
  width: 240,
  height: 120,
  ether: {
    entity: { kind: "requests" },
    requests: { items: [] },
  },
});

// Artifact shelf — published parts with optional task provenance.
export const makeArtifactsNode = (x: number, y: number): TextNode => ({
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
});

/** Bulletin board sink — topics + posts; work-plane owns durability. */
export const makeBoardNode = (x: number, y: number): TextNode => ({
  id: `board-${ulid()}`,
  type: "text",
  text: "quiet",
  x: Math.round(x),
  y: Math.round(y),
  width: 240,
  height: 120,
  ether: {
    entity: { kind: "board" },
    board: { topics: [] },
  },
});

// A herdr work-surface node — binds a live herdr pane (local or remote).
// Not a hermes agent: no EntitySource binding, no ACP, no pulse target.
export const makeHerdrNode = (
  x: number,
  y: number,
  herdr: EtherHerdr,
  label?: string,
): TextNode => {
  const title =
    label?.trim() ||
    herdr.label?.trim() ||
    [herdr.host, herdr.paneId].filter(Boolean).join(" - ") ||
    "herdr";
  return {
    id: `herdr-${ulid()}`,
    type: "text",
    text: title,
    x: Math.round(x),
    y: Math.round(y),
    width: 260,
    height: 110,
    ether: {
      entity: { kind: "herdr" },
      host: herdr.host,
      herdr: {
        ...herdr,
        onDelete: herdr.onDelete ?? "detach",
      },
    },
  };
};

/** Vellum Command-owned terminal node. Session starts on create / open (no card Start). */
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
 * No sourceNodeId on the node body.
 */
export const makeRelayNode = (
  x: number,
  y: number,
  _sourceNodeId?: string,
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
