import type { CanvasNode } from "@shared/canvas";

export const searchText = (node: CanvasNode): string => [
  node.type,
  node.type === "text" ? node.text : "",
  node.type === "file" ? node.file : "",
  node.type === "file" ? node.subpath ?? "" : "",
  node.type === "link" ? node.url : "",
  node.type === "group" ? node.label ?? "" : "",
  node.ether?.entity?.kind ?? "",
  ...(node.ether?.flags ?? []),
  ...(node.ether?.bindings ?? []).flatMap((binding) => [binding.source, binding.ref.key]),
].join(" ").toLowerCase();

export const nodeTitle = (node: CanvasNode): string => {
  if (node.type === "text") return node.text.split("\n")[0]?.replace(/^#+\s*/, "") || "untitled";
  if (node.type === "file") return node.file.split("/").filter(Boolean).pop() ?? node.file;
  if (node.type === "link") {
    try { return new URL(node.url).host; } catch { return node.url; }
  }
  return node.label ?? "region";
};

export const nodeDetail = (node: CanvasNode): string => {
  if (node.type === "text") {
    const detail = node.text.split("\n").slice(1).join(" ").trim();
    if (detail) return detail;
  }
  if (node.type === "file") return node.subpath ? `${node.file} ${node.subpath}` : node.file;
  if (node.type === "link") return node.url;
  if (node.type === "group") return "Spatial region";
  const bindings = (node.ether?.bindings ?? []).map((binding) => `${binding.source} / ${binding.ref.key}`);
  return bindings.join(" · ") || "No description recorded.";
};
