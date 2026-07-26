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

export const makeTextNode = (x: number, y: number): TextNode => ({
  id: `node-${ulid()}`,
  type: "text",
  text: "new note",
  x: Math.round(x),
  y: Math.round(y),
  width: 240,
  height: 100,
});

export const makeFileNode = (x: number, y: number): FileNode => ({
  id: `node-${ulid()}`,
  type: "file",
  file: "docs/untitled.md",
  x: Math.round(x),
  y: Math.round(y),
  width: 260,
  height: 110,
});

export const makeLinkNode = (x: number, y: number): LinkNode => ({
  id: `node-${ulid()}`,
  type: "link",
  url: "https://example.com",
  x: Math.round(x),
  y: Math.round(y),
  width: 260,
  height: 110,
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
    readonly host?: string;
    readonly profile?: string;
    readonly model?: string;
    readonly effort?: string;
    readonly cwd?: string;
    readonly label?: string;
  },
): TextNode => {
  const host = options.host?.trim() || "local";
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
      ? `${host}:${options.profile}`
      : `${host}:${options.harness}`;
  const parts = [
    template.displayName,
    options.profile,
    options.model,
    options.effort,
  ].filter((p): p is string => Boolean(p && p.trim()));
  const label = options.label?.trim() || parts.join(" · ");
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
    width: 260,
    height: 110,
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
 * @deprecated Bare agents are illegal. Always creates a managed-terminal seat.
 * Prefer makeManagedAgentNode with an explicit harness.
 */
export const makeAgentNode = (
  x: number,
  y: number,
  label: string,
  key: string,
  host = "local",
): TextNode => {
  const parts = key.split(":");
  const profile = parts.length > 1 ? parts.slice(1).join(":") : undefined;
  // Default harness claude — legacy callers must not produce agent-without-terminal.
  return makeManagedAgentNode(x, y, {
    harness: "claude",
    host,
    ...(profile ? { profile } : {}),
    label,
  });
};

// A tasks node — task list; blocks only when edged with criteria.mode tasks.
export const makeTasksNode = (x: number, y: number): TextNode => ({
  id: `task-${ulid()}`,
  type: "text",
  text: "tasks",
  x: Math.round(x),
  y: Math.round(y),
  width: 240,
  height: 120,
  ether: {
    entity: { kind: "task" },
    tasks: { items: [] },
  },
});

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
    [herdr.host, herdr.paneId].filter(Boolean).join(" · ") ||
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

/** Vellum-owned terminal node. Session starts on create / open (no card Start). */
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

/** Watcher predicate node — stamps host for host-scoped kernel fire. */
export const makeWatcherNode = (
  x: number,
  y: number,
  host = "local",
): TextNode => ({
  id: `watch-${ulid()}`,
  type: "text",
  text: "watcher",
  x: Math.round(x),
  y: Math.round(y),
  width: 220,
  height: 96,
  ether: {
    entity: { kind: "watcher" },
    host,
    watch: { kind: "glyphs_done" },
  },
});

/** Timer clock node — stamps host for host-scoped kernel fire. */
export const makeTimerNode = (
  x: number,
  y: number,
  everyMinutes = 30,
  host = "local",
): TextNode => ({
  id: `timer-${ulid()}`,
  type: "text",
  text: "timer",
  x: Math.round(x),
  y: Math.round(y),
  width: 200,
  height: 88,
  ether: {
    entity: { kind: "timer" },
    host,
    timer: { everyMinutes },
  },
});
