import { ulid } from "ulid";
import type { EtherBinding, FileNode, GroupNode, LinkNode, TextNode } from "@shared/canvas";

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

// A project is ONE bound text node — its name in the current hue plus a compact
// stat readout hydrated from the sources it binds to. It never explodes into
// child nodes.
export const makeProjectNode = (
  x: number,
  y: number,
  label: string,
  bindings: ReadonlyArray<EtherBinding>,
): TextNode => ({
  id: `proj-${ulid()}`,
  type: "text",
  text: label,
  x: Math.round(x),
  y: Math.round(y),
  width: 240,
  height: 96,
  ether: { entity: { kind: "project" }, bindings: [...bindings] },
});

// An agent node — profile name plus its live hermes readout (running/stopped,
// model, version).
export const makeAgentNode = (
  x: number,
  y: number,
  label: string,
  key: string,
): TextNode => ({
  id: `agent-${ulid()}`,
  type: "text",
  text: label,
  x: Math.round(x),
  y: Math.round(y),
  width: 240,
  height: 96,
  ether: { entity: { kind: "agent" }, bindings: [{ source: "hermes", ref: { type: "agent", key } }] },
});
