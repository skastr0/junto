import { Schema } from "effect";
import { EtherNodeExtension } from "../canvas";
import { Node } from "./kinds";
import { SheetGrid } from "./sheet";
import { Wire } from "./wire";

/** Temporary cutover input, confined to the migration and old-row reader. */
export interface LegacyNodeRow {
  readonly canvas_name: string;
  readonly node_id: string;
  readonly type: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly z_index: number;
  readonly color?: string | null;
  readonly text_content?: string | null;
  readonly file_path?: string | null;
  readonly file_subpath?: string | null;
  readonly link_url?: string | null;
  readonly group_label?: string | null;
  readonly group_background?: string | null;
  readonly group_background_style?: string | null;
  readonly ether_json?: string | null;
}

const decodeExtension = Schema.decodeUnknownSync(
  Schema.fromJsonString(EtherNodeExtension),
);
const decodeNode = Schema.decodeUnknownSync(Node);
const present = <T>(
  key: string,
  value: T | null | undefined,
): Record<string, T> =>
  value === null || value === undefined ? {} : { [key]: value };

/** Pure conversion, validates the new kind and never reads or projects Work. */
const decodeStoredKind = (row: LegacyNodeRow): Node => {
  const old =
    row.ether_json == null ? undefined : decodeExtension(row.ether_json);
  const base = {
    id: row.node_id,
    x: row.x,
    y: row.y,
    width: row.width,
    height: row.height,
    z: row.z_index,
    ...present("color", row.color),
  };
  const text = row.text_content ?? "";
  // An old card's text was its title on the first line, then mirrored content.
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const labelled = {
    ...base,
    ...(firstLine === "" ? {} : { label: firstLine }),
  };
  const host = old?.host ?? "local";
  if (row.type === "group")
    return decodeNode({
      ...base,
      kind: "region",
      ...present("label", row.group_label),
      hold: old?.region?.hold ?? false,
      ...present("instruction", old?.region?.instruction),
      ...present("defaults", old?.region?.defaults),
      ...present("contract", old?.region?.contract),
      ...present("environment", old?.region?.environment),
      ...present("background", row.group_background),
      ...present("backgroundStyle", row.group_background_style),
    });
  switch (old?.entity?.kind) {
    case "agent":
      return decodeNode({
        ...base,
        kind: "agent",
        agentKey: old.entity.name,
        label: firstLine,
        host,
        overseer: old.overseer ?? false,
        bindingId: old.terminal?.bindingId,
        harness: old.terminal?.harness,
        onRemove: old.terminal?.onDelete ?? "detach",
        ...present("launch", old.terminal?.launch),
        ...present("sessionId", old.terminal?.sessionId),
      });
    case "terminal":
      return decodeNode({
        ...labelled,
        kind: "terminal",
        host,
        bindingId: old.terminal?.bindingId,
        onRemove: old.terminal?.onDelete ?? "detach",
        ...present("launch", old.terminal?.launch),
      });
    case "page":
      return decodeNode({
        ...base,
        kind: "page",
        host,
        url: row.link_url ?? "",
        profile: old.browser?.profile ?? "default",
        onRemove: old.browser?.onDelete ?? "kill-session",
      });
    case "task":
      return decodeNode({
        ...base,
        kind: "task",
        ...present("name", old.tasks?.name),
        ...present("contract", old.tasks?.contract),
      });
    case "requests":
      return decodeNode({
        ...base,
        kind: "requests",
        ...present("name", old.requests?.name),
      });
    case "artifacts":
    case "board":
    case "pad":
    case "relay":
      return decodeNode({ ...labelled, kind: old.entity.kind });
    case "sheet":
      return decodeNode({ ...labelled, kind: "sheet" });
    case "cron":
    case "timer": {
      const minutes = old.timer?.everyMinutes;
      const expression =
        old.timer?.expression ??
        (minutes !== undefined &&
        Number.isInteger(minutes) &&
        minutes > 0 &&
        minutes <= 59
          ? `*/${minutes} * * * *`
          : minutes !== undefined &&
              Number.isInteger(minutes) &&
              minutes > 0 &&
              minutes % 60 === 0 &&
              minutes / 60 <= 23
            ? `0 */${minutes / 60} * * *`
            : undefined);
      return decodeNode({ ...labelled, kind: "cron", expression });
    }
    case "watcher":
      return decodeNode({
        ...labelled,
        kind: "watcher",
        ...present("key", old.watch?.key),
        ...present("stat", old.watch?.stat),
        ...present("op", old.watch?.op),
        ...present("value", old.watch?.value),
      });
    case "label":
      return decodeNode({ ...base, kind: "label", text });
    case "git":
      return decodeNode({ ...labelled, kind: "git", cwd: old.git?.cwd });
    default:
      if (old?.entity?.kind === undefined && row.type === "file")
        return decodeNode({
          ...base,
          kind: "file",
          path: row.file_path,
          ...present("subpath", row.file_subpath),
        });
      if (old?.entity?.kind === undefined && row.type === "link")
        return decodeNode({
          ...base,
          kind: "link",
          url: row.link_url ?? "",
        });
      return decodeNode({ ...base, kind: "note", text });
  }
};

export interface StoredNodeConversion {
  readonly node: Node;
  readonly downgraded?: {
    readonly canvas: string;
    readonly id: string;
    readonly storedType: string;
    readonly reason: string;
  };
}

/** Invalid retired descriptors keep their identity and text as a note. */
export const convertLegacyRow = (row: LegacyNodeRow): StoredNodeConversion => {
  try {
    const node = decodeStoredKind(row);
    const descriptor =
      row.ether_json == null ? undefined : decodeExtension(row.ether_json);
    return {
      node,
      ...(node.kind === "note" && descriptor?.entity?.kind !== undefined
        ? {
            downgraded: {
              canvas: row.canvas_name,
              id: row.node_id,
              storedType: descriptor.entity.kind,
              reason: "stored kind is no longer supported; preserved as a note",
            },
          }
        : {}),
    };
  } catch (cause) {
    const finite = (value: number, fallback: number) =>
      Number.isFinite(value) ? value : fallback;
    const width = finite(row.width, 220),
      height = finite(row.height, 90);
    return {
      node: decodeNode({
        kind: "note",
        id: row.node_id,
        x: finite(row.x, 0),
        y: finite(row.y, 0),
        width: width > 0 ? width : 220,
        height: height > 0 ? height : 90,
        z: Number.isSafeInteger(row.z_index) ? row.z_index : 0,
        text:
          row.text_content ??
          row.group_label ??
          row.file_path ??
          row.link_url ??
          "",
      }),
      downgraded: {
        canvas: row.canvas_name,
        id: row.node_id,
        storedType: row.type,
        reason: cause instanceof Error ? cause.message : String(cause),
      },
    };
  }
};
export const nodeFromLegacyRow = (row: LegacyNodeRow): Node =>
  convertLegacyRow(row).node;

const decodeGrid = Schema.decodeUnknownSync(SheetGrid);

/** What an old sheet row held, or nothing when the row is not a sheet. */
export const sheetGridFromLegacyRow = (
  row: LegacyNodeRow,
): SheetGrid | undefined => {
  const old =
    row.ether_json == null ? undefined : decodeExtension(row.ether_json);
  if (old?.entity?.kind !== "sheet") return undefined;
  return decodeGrid({
    columns: old.sheet?.columns ?? [],
    rows: old.sheet?.rows ?? [],
  });
};

export interface LegacyWireRow {
  readonly canvas_name: string;
  readonly edge_id: string;
  readonly from_node_id: string;
  readonly to_node_id: string;
  readonly from_side?: string | null;
  readonly to_side?: string | null;
  readonly ether_json?: string | null;
}
const OldWire = Schema.Struct({
  verb: Wire.fields.verb,
  mask: Wire.fields.mask,
});
const decodeOldWire = Schema.decodeUnknownSync(Schema.fromJsonString(OldWire));
const decodeWire = Schema.decodeUnknownSync(Wire);
export const wireFromLegacyRow = (row: LegacyWireRow): Wire => {
  const old = decodeOldWire(row.ether_json);
  return decodeWire({
    id: row.edge_id,
    from: row.from_node_id,
    to: row.to_node_id,
    ...old,
    ...present("fromSide", row.from_side),
    ...present("toSide", row.to_side),
  });
};
