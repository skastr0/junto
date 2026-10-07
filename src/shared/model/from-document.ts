/** Temporary window bootstrap; removed with the final document reader. */
import type { CanvasEdge, CanvasNode } from "../canvas";
import { nodeFromLegacyRow, wireFromLegacyRow } from "./from-legacy-row";

export const nodeFromDocument = (canvas: string, node: CanvasNode, z: number) =>
  nodeFromLegacyRow({
    canvas_name: canvas, node_id: node.id, type: node.type,
    x: node.x, y: node.y, width: node.width, height: node.height, z_index: z,
    color: node.color, ether_json: node.ether === undefined ? null : JSON.stringify(node.ether),
    ...(node.type === "text" ? { text_content: node.text } : {}),
    ...(node.type === "file" ? { file_path: node.file, file_subpath: node.subpath } : {}),
    ...(node.type === "link" ? { link_url: node.url } : {}),
    ...(node.type === "group" ? { group_label: node.label, group_background: node.background, group_background_style: node.backgroundStyle } : {}),
  });

export const wireFromDocument = (canvas: string, wire: CanvasEdge) =>
  wireFromLegacyRow({
    canvas_name: canvas, edge_id: wire.id, from_node_id: wire.fromNode, to_node_id: wire.toNode,
    from_side: wire.fromSide, to_side: wire.toSide,
    ether_json: wire.ether === undefined ? null : JSON.stringify(wire.ether),
  });
