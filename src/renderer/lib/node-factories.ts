import { ulid } from "ulid";
import type {
  EtherBrowser,
  EtherHerdr,
  FileNode,
  GroupNode,
  LinkNode,
  TextNode,
} from "@shared/canvas";

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

// A project is ONE identity card — its name in the current hue plus a compact
// stat readout derived live from every source that knows it. `name` is the
// immutable identity stamped at creation; the visible label stays free.
export const makeProjectNode = (
  x: number,
  y: number,
  label: string,
  name: string,
): TextNode => ({
  id: `proj-${ulid()}`,
  type: "text",
  text: label,
  x: Math.round(x),
  y: Math.round(y),
  width: 240,
  height: 96,
  ether: { entity: { kind: "project", name } },
});

// An agent node — profile name plus its live hermes readout (running/stopped,
// model, version).
export const makeAgentNode = (
  x: number,
  y: number,
  label: string,
  key: string,
  host = "local",
): TextNode => ({
  id: `agent-${ulid()}`,
  type: "text",
  text: label,
  x: Math.round(x),
  y: Math.round(y),
  width: 240,
  height: 96,
  ether: { entity: { kind: "agent", name: key }, host },
});

// A tasks node — local checklist that can block only when connected by an
// edge with criteria.mode === "tasks". Never auto-creates edges.
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
    tasks: {
      items: [{ id: `item-${ulid()}`, text: "first item" }],
    },
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
        onDelete: browser?.onDelete ?? "detach",
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
