import { createHash } from "node:crypto";
import type { CanvasDoc, CanvasEdge, CanvasNode } from "@shared/canvas";
import { canonicalJson } from "../work/canonical-json";

export const sha256Utf8 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

export const nodeSemanticHash = (node: CanvasNode): string => {
  const norm = {
    id: node.id,
    type: node.type,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    color: node.color ?? null,
    text: node.type === "text" ? node.text : null,
    file: node.type === "file" ? node.file : null,
    subpath: node.type === "file" ? node.subpath ?? null : null,
    url: node.type === "link" ? node.url : null,
    label: node.type === "group" ? node.label ?? null : null,
    background: node.type === "group" ? node.background ?? null : null,
    backgroundStyle: node.type === "group" ? node.backgroundStyle ?? null : null,
    ether: node.ether ?? null,
  };
  return sha256Utf8(canonicalJson(norm));
};

export const edgeSemanticHash = (edge: CanvasEdge): string => {
  const norm = {
    id: edge.id,
    fromNode: edge.fromNode,
    fromSide: edge.fromSide ?? null,
    fromEnd: edge.fromEnd ?? null,
    toNode: edge.toNode,
    toSide: edge.toSide ?? null,
    toEnd: edge.toEnd ?? null,
    verb: edge.ether?.verb ?? null,
    color: edge.color ?? null,
    label: edge.label ?? null,
    ether: edge.ether ?? null,
  };
  return sha256Utf8(canonicalJson(norm));
};

export const canvasDocSemanticHash = (doc: CanvasDoc): string => {
  const nodeHashes = doc.nodes.map(nodeSemanticHash).sort();
  const edgeHashes = doc.edges.map(edgeSemanticHash).sort();
  return sha256Utf8(canonicalJson({ nodeHashes, edgeHashes }));
};
