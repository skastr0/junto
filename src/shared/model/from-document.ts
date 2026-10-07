/** Temporary window bootstrap; removed with the final document reader. */
import type { CanvasEdge, CanvasNode, Task } from "../canvas";
import { asCanvasName } from "./base";
import type { Canvas } from "./canvas";
import { nodeFromLegacyRow, wireFromLegacyRow } from "./from-legacy-row";
import type { Node } from "./kinds";
import type { Wire } from "./wire";

export const nodeFromDocument = (
  canvas: string,
  node: CanvasNode,
  z: number,
): Node => {
  const row = nodeFromLegacyRow({
    canvas_name: canvas,
    node_id: node.id,
    type: node.type,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    z_index: z,
    color: node.color,
    ether_json: node.ether === undefined ? null : JSON.stringify(node.ether),
    ...(node.type === "text" ? { text_content: node.text } : {}),
    ...(node.type === "file"
      ? { file_path: node.file, file_subpath: node.subpath }
      : {}),
    ...(node.type === "link" ? { link_url: node.url } : {}),
    ...(node.type === "group"
      ? {
          group_label: node.label,
          group_background: node.background,
          group_background_style: node.backgroundStyle,
        }
      : {}),
  });
  return row;
};

export const wireFromDocument = (canvas: string, wire: CanvasEdge) =>
  wireFromLegacyRow({
    canvas_name: canvas,
    edge_id: wire.id,
    from_node_id: wire.fromNode,
    to_node_id: wire.toNode,
    from_side: wire.fromSide,
    to_side: wire.toSide,
    ether_json: wire.ether === undefined ? null : JSON.stringify(wire.ether),
  });

type Document = {
  readonly nodes: ReadonlyArray<CanvasNode>;
  readonly edges: ReadonlyArray<CanvasEdge>;
};

type Held<Row> = { readonly z: number; readonly row: Row | undefined };
const heldNodeRows = new WeakMap<CanvasNode, Held<Node>>();
const heldWireRows = new WeakMap<CanvasEdge, Held<Wire>>();

/**
 * The node a document node describes, or nothing when the model refuses it.
 * Worked out once per node object and place in the stack: a document is a new
 * object on every change but keeps the objects of the nodes the change did
 * not touch. A node does not carry the name of its canvas.
 */
export const nodeOfDocument = (
  canvas: string,
  node: CanvasNode,
  z: number,
): Node | undefined => {
  const known = heldNodeRows.get(node);
  if (known !== undefined && known.z === z) return known.row;
  let row: Node | undefined;
  try {
    row = nodeFromDocument(canvas, node, z);
  } catch {
    // Not a kind the model knows.
  }
  heldNodeRows.set(node, { z, row });
  return row;
};

/** The wire a document edge describes, or nothing; once per edge object. */
export const wireOfDocument = (edge: CanvasEdge): Wire | undefined => {
  const known = heldWireRows.get(edge);
  if (known !== undefined) return known.row;
  let row: Wire | undefined;
  try {
    row = wireFromDocument("", edge);
  } catch {
    // Not a wire.
  }
  heldWireRows.set(edge, { z: 0, row });
  return row;
};

const heldWires = new WeakMap<object, Pick<Canvas, "wires">>();

/**
 * The wires a document describes, for a caller that holds a document and not
 * the name of its canvas. Worked out once per document object. An edge with
 * no verb, or one the model does not know, is not a wire; of two with one id
 * the first is kept.
 */
export const wiresFromDocument = (
  doc: Pick<Document, "edges">,
): Pick<Canvas, "wires"> => {
  const known = heldWires.get(doc);
  if (known !== undefined) return known;
  const wires = new Map<Wire["id"], Wire>();
  for (const edge of doc.edges) {
    const row = wireOfDocument(edge);
    if (row !== undefined && !wires.has(row.id)) wires.set(row.id, row);
  }
  const made = { wires };
  heldWires.set(doc, made);
  return made;
};

const held = new WeakMap<object, Canvas>();

/**
 * The canvas a document describes, for a caller that still holds a document.
 * Worked out once per document object. A node the model refuses is left out,
 * the same as it would be when the old rows are read; of two with one id the
 * first is kept.
 */
export const canvasFromDocument = (name: string, doc: Document): Canvas => {
  const known = held.get(doc);
  if (known !== undefined && known.name === name) return known;
  const nodes = new Map<Node["id"], Node>();
  doc.nodes.forEach((node, z) => {
    const row = nodeOfDocument(name, node, z);
    if (row !== undefined && !nodes.has(row.id)) nodes.set(row.id, row);
  });
  const canvas: Canvas = {
    name: asCanvasName(name),
    seq: 0,
    nodes,
    wires: wiresFromDocument(doc).wires,
  };
  held.set(doc, canvas);
  return canvas;
};

const NO_ITEMS: ReadonlyArray<Task> = [];
const heldItems = new WeakMap<
  object,
  (nodeId: string) => ReadonlyArray<Task>
>();

/**
 * The task and request items a document carries, by node id, for a caller
 * that still reads work out of the document. A canvas holds no work.
 */
export const workItemsFromDocument = (
  doc: Pick<Document, "nodes">,
): ((nodeId: string) => ReadonlyArray<Task>) => {
  const known = heldItems.get(doc);
  if (known !== undefined) return known;
  const byId = new Map<string, ReadonlyArray<Task>>();
  for (const node of doc.nodes) {
    if (byId.has(node.id)) continue;
    const kind = node.ether?.entity?.kind;
    if (kind === "requests")
      byId.set(node.id, node.ether?.requests?.items ?? NO_ITEMS);
    else if (kind === "task")
      byId.set(node.id, node.ether?.tasks?.items ?? NO_ITEMS);
  }
  const itemsOf = (nodeId: string): ReadonlyArray<Task> =>
    byId.get(nodeId) ?? NO_ITEMS;
  heldItems.set(doc, itemsOf);
  return itemsOf;
};

/** Temporary facade output for callers being moved to model reads. No Work. */
export const nodeToDocument = (node: Node): CanvasNode => {
  const frame = {
    id: node.id,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    ...(node.color === undefined ? {} : { color: node.color }),
  };
  const entity = (kind: string, name?: string) => ({
    entity: { kind, ...(name === undefined ? {} : { name }) },
  });
  const text = (body: string, ether?: CanvasNode["ether"]): CanvasNode => ({
    ...frame,
    type: "text",
    text: body,
    ...(ether === undefined ? {} : { ether }),
  });
  const labelled = "label" in node ? (node.label ?? "") : "";
  switch (node.kind) {
    case "agent":
      return text(node.label, {
        ...entity("agent", node.agentKey),
        host: node.host,
        ...(node.overseer ? { overseer: true } : {}),
        terminal: {
          bindingId: node.bindingId,
          harness: node.harness,
          onDelete: node.onRemove,
          ...(node.launch === undefined ? {} : { launch: node.launch }),
          ...(node.sessionId === undefined
            ? {}
            : { sessionId: node.sessionId }),
        },
      });
    case "terminal":
      return text(labelled, {
        ...entity("terminal"),
        host: node.host,
        terminal: {
          bindingId: node.bindingId,
          onDelete: node.onRemove,
          ...(node.launch === undefined ? {} : { launch: node.launch }),
        },
      });
    case "page":
      return {
        ...frame,
        type: "link",
        url: node.url,
        ether: {
          ...entity("page"),
          host: node.host,
          browser: { profile: node.profile, onDelete: node.onRemove },
        },
      };
    case "region":
      return {
        ...frame,
        type: "group",
        ...(node.label === undefined ? {} : { label: node.label }),
        ...(node.background === undefined
          ? {}
          : { background: node.background }),
        ...(node.backgroundStyle === undefined
          ? {}
          : { backgroundStyle: node.backgroundStyle }),
        ether: {
          region: {
            hold: node.hold,
            ...(node.instruction === undefined
              ? {}
              : { instruction: node.instruction }),
            ...(node.defaults === undefined ? {} : { defaults: node.defaults }),
            ...(node.contract === undefined ? {} : { contract: node.contract }),
            ...(node.environment === undefined
              ? {}
              : { environment: node.environment }),
          },
        },
      };
    case "task":
      return text(node.name ?? "", {
        ...entity("task"),
        tasks: {
          items: [],
          ...(node.name === undefined ? {} : { name: node.name }),
          ...(node.contract === undefined ? {} : { contract: node.contract }),
        },
      });
    case "requests":
      return text(node.name ?? "", {
        ...entity("requests"),
        requests: {
          items: [],
          ...(node.name === undefined ? {} : { name: node.name }),
        },
      });
    case "cron":
      return text(labelled, {
        ...entity("cron"),
        timer: {
          ...(node.expression === undefined
            ? {}
            : { expression: node.expression }),
        },
        host: node.host,
      });
    case "watcher":
      return text(labelled, {
        ...entity("watcher"),
        host: node.host,
        watch: {
          source: "hermes",
          kind: "stat_threshold",
          ...(node.key === undefined ? {} : { key: node.key }),
          ...(node.stat === undefined ? {} : { stat: node.stat }),
          ...(node.op === undefined ? {} : { op: node.op }),
          ...(node.value === undefined ? {} : { value: node.value }),
        },
      });
    case "note":
      return text(node.text);
    case "label":
      return text(node.text, entity("label"));
    case "file":
      return {
        ...frame,
        type: "file",
        file: node.path,
        ...(node.subpath === undefined ? {} : { subpath: node.subpath }),
      };
    case "link":
      return { ...frame, type: "link", url: node.url };
    case "git":
      return text(labelled, { ...entity("git"), git: { cwd: node.cwd } });
    case "relay":
      return text(labelled, { ...entity("relay"), host: node.host });
    default:
      return text(labelled, entity(node.kind));
  }
};
export const wireToDocument = (wire: Wire): CanvasEdge => ({
  id: wire.id,
  fromNode: wire.from,
  toNode: wire.to,
  ...(wire.fromSide === undefined ? {} : { fromSide: wire.fromSide }),
  ...(wire.toSide === undefined ? {} : { toSide: wire.toSide }),
  ether: {
    verb: wire.verb,
    ...(wire.mask === undefined ? {} : { mask: wire.mask }),
  },
});
