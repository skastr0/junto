import { ulid } from "ulid";
import type { FileNode, GroupNode, LinkNode, TextNode } from "@shared/canvas";

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

export const makeGroupNode = (x: number, y: number): GroupNode => ({
  id: `region-${ulid()}`,
  type: "group",
  label: "new region",
  x: Math.round(x),
  y: Math.round(y),
  width: 560,
  height: 320,
});
