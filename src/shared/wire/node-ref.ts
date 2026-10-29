// Canonical, locator-only references to nodes in Junto canvas documents.
// A Junto URI identifies a document-local node; it carries no authority and
// never encodes an action, URL, browser profile, token, path, or capability.
// A wire module (0.11.3), effect-free so the preload still loads without
// Schema; `src/shared/node-ref.ts` re-exports it.

import { isCanonicalCanvasName } from "./canvas-name";
import { isUlid } from "./ulid";
import type { ItemId } from "./ids";

/** An item id is a ULID; checked here without Schema, so the preload stays effect-free. */
const isItemId = (text: string): text is ItemId => isUlid(text);

/**
 * A node, or an item inside it with `itemId` (`&item=<itemId>`). The canvas
 * name is part of the canonical form, but a resolver keys on the node id and
 * item and takes the canvas from context, so a renamed canvas's old links
 * still resolve.
 */
export interface NodeRef {
  readonly canvasName: string;
  readonly nodeId: string;
  readonly itemId?: ItemId;
}

export type NodeRefKey = string;

export type NodeRefErrorCode =
  | "scheme"
  | "authority"
  | "shape"
  | "canvas_name"
  | "encoding"
  | "node_id"
  | "item_id"
  | "canonical";

export interface NodeRefParseError {
  readonly code: NodeRefErrorCode;
  readonly message: string;
  readonly canonical?: string;
}

export type NodeRefSchemaIssue =
  | { readonly ok: true; readonly value: NodeRef }
  | { readonly ok: false; readonly error: NodeRefParseError };

export class NodeRefFormatError extends Error {
  readonly name = "NodeRefFormatError";

  constructor(
    readonly code: Extract<NodeRefErrorCode, "canvas_name" | "node_id" | "item_id" | "encoding">,
    message: string,
  ) {
    super(message);
  }
}

const SCHEME = "junto";
const AUTHORITY = "canvas";
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const MAX_URI_LENGTH = 4_096;
const MAX_NODE_ID_BYTES = 512;

const fail = (
  code: NodeRefErrorCode,
  message: string,
  canonical?: string,
): NodeRefSchemaIssue => ({
  ok: false,
  error: { code, message, ...(canonical === undefined ? {} : { canonical }) },
});

const validateCanvasName = (canvasName: string): boolean => isCanonicalCanvasName(canvasName);

const validateNodeId = (nodeId: string): boolean =>
  nodeId.length > 0 &&
  !CONTROL_CHARACTER.test(nodeId) &&
  new TextEncoder().encode(nodeId).byteLength <= MAX_NODE_ID_BYTES;

const encodeRfc3986Segment = (value: string): string =>
  encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

export const formatNodeRef = (ref: NodeRef): NodeRefKey => {
  if (!validateCanvasName(ref.canvasName)) {
    throw new NodeRefFormatError(
      "canvas_name",
      "canvas name must use at most 64 lowercase letters, numbers, hyphens, and underscores",
    );
  }
  if (!validateNodeId(ref.nodeId)) {
    throw new NodeRefFormatError(
      "node_id",
      "node id must be non-empty, bounded UTF-8 without control characters",
    );
  }

  let encodedNodeId: string;
  try {
    encodedNodeId = encodeRfc3986Segment(ref.nodeId);
  } catch {
    throw new NodeRefFormatError("encoding", "node id is not valid Unicode");
  }
  if (ref.itemId !== undefined && !isItemId(ref.itemId)) {
    throw new NodeRefFormatError("item_id", "item id must be a ULID");
  }
  const item = ref.itemId === undefined ? "" : `&item=${ref.itemId}`;
  return `${SCHEME}://${AUTHORITY}/${ref.canvasName}?node=${encodedNodeId}${item}`;
};

export const nodeRefKey = (ref: NodeRef): NodeRefKey => formatNodeRef(ref);

export const parseNodeRef = (input: string): NodeRefSchemaIssue => {
  if (
    input.length === 0 ||
    new TextEncoder().encode(input).byteLength > MAX_URI_LENGTH ||
    CONTROL_CHARACTER.test(input)
  ) {
    return fail("shape", "Junto reference is empty, oversized, or contains control characters");
  }

  const schemeEnd = input.indexOf("://");
  if (schemeEnd < 0 || input.slice(0, schemeEnd) !== SCHEME) {
    return fail("scheme", "Junto reference must use the lowercase junto scheme");
  }

  const afterScheme = input.slice(schemeEnd + 3);
  const authorityEnd = afterScheme.indexOf("/");
  if (authorityEnd < 0 || afterScheme.slice(0, authorityEnd) !== AUTHORITY) {
    return fail("authority", "Junto reference authority must be exactly canvas");
  }
  if (input.includes("#")) {
    return fail("shape", "Junto references do not accept fragments");
  }

  const pathAndQuery = afterScheme.slice(authorityEnd + 1);
  const queryStart = pathAndQuery.indexOf("?");
  if (queryStart < 0 || pathAndQuery.indexOf("?", queryStart + 1) >= 0) {
    return fail("shape", "Junto reference must contain exactly one node query");
  }

  const canvasName = pathAndQuery.slice(0, queryStart);
  const [nodeParam, itemParam, ...extra] = pathAndQuery.slice(queryStart + 1).split("&");
  if (
    canvasName.includes("/") ||
    extra.length > 0 ||
    !nodeParam!.startsWith("node=") ||
    (itemParam !== undefined && !itemParam.startsWith("item="))
  ) {
    return fail("shape", "Junto reference must be /<canvas-name>?node=<node-id>, optionally &item=<item-id>");
  }
  const encodedNodeId = nodeParam!.slice("node=".length);
  if (encodedNodeId.length === 0) {
    return fail("node_id", "node id must not be empty");
  }
  if (!validateCanvasName(canvasName)) {
    return fail("canvas_name", "canvas name must use lowercase letters, numbers, and hyphens");
  }

  let nodeId: string;
  try {
    nodeId = decodeURIComponent(encodedNodeId);
  } catch {
    return fail("encoding", "node id contains malformed percent encoding");
  }
  if (!validateNodeId(nodeId)) {
    return fail("node_id", "node id is empty, oversized, or contains a forbidden character");
  }

  const itemId = itemParam?.slice("item=".length);
  if (itemId !== undefined && !isItemId(itemId)) {
    return fail("item_id", "item id must be a ULID");
  }

  const value: NodeRef = { canvasName, nodeId, ...(itemId === undefined ? {} : { itemId }) };
  let canonical: NodeRefKey;
  try {
    canonical = formatNodeRef(value);
  } catch {
    return fail("encoding", "node id is not valid Unicode");
  }
  if (canonical !== input) {
    return fail("canonical", "Junto reference is not in canonical form", canonical);
  }
  return { ok: true, value };
};
