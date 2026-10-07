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

const decodeExtension = Schema.decodeUnknownSync(Schema.fromJsonString(EtherNodeExtension));
const decodeNode = Schema.decodeUnknownSync(Node);
const present = <T>(key: string, value: T | null | undefined): Record<string, T> =>
  value === null || value === undefined ? {} : { [key]: value };

/** Pure conversion, validates the new kind and never reads or projects Work. */
export const nodeFromLegacyRow = (row: LegacyNodeRow): Node => {
  const old = row.ether_json == null ? undefined : decodeExtension(row.ether_json);
  const base = {
    id: row.node_id,
    x: row.x, y: row.y, width: row.width, height: row.height, z: row.z_index,
    ...present("color", row.color),
  };
  const text = row.text_content ?? "";
  const labelled = { ...base, ...present("label", row.text_content) };
  const host = old?.host ?? "local";
  if (row.type === "group") return decodeNode({
    ...base, kind: "region", ...present("label", row.group_label),
    hold: old?.region?.hold ?? false,
    ...present("instruction", old?.region?.instruction),
    ...present("defaults", old?.region?.defaults),
    ...present("contract", old?.region?.contract),
    ...present("environment", old?.region?.environment),
    ...present("background", row.group_background),
    ...present("backgroundStyle", row.group_background_style),
  });
  switch (old?.entity?.kind) {
    case "agent": return decodeNode({
      ...base, kind: "agent", name: old.entity.name, label: text.split(/\r?\n/, 1)[0] ?? "",
      host, overseer: old.overseer ?? false, bindingId: old.terminal?.bindingId,
      harness: old.terminal?.harness, onRemove: old.terminal?.onDelete ?? "detach",
      ...present("launch", old.terminal?.launch),
      ...present("sessionId", old.terminal?.sessionId),
    });
    case "terminal": return decodeNode({
      ...labelled, kind: "terminal", host, bindingId: old.terminal?.bindingId,
      onRemove: old.terminal?.onDelete ?? "detach", ...present("launch", old.terminal?.launch),
    });
    case "page": return decodeNode({
      ...base, kind: "page", host, url: row.link_url ?? "",
      profile: old.browser?.profile ?? "default", onRemove: old.browser?.onDelete ?? "kill-session",
    });
    case "task": return decodeNode({
      ...base, kind: "task", ...present("name", old.tasks?.name), ...present("contract", old.tasks?.contract),
    });
    case "requests": return decodeNode({ ...base, kind: "requests", ...present("name", old.requests?.name) });
    case "artifacts": case "board": case "pad": case "relay":
      return decodeNode({ ...labelled, kind: old.entity.kind });
    case "sheet": return decodeNode({ ...labelled, kind: "sheet" });
    case "cron": case "timer": {
      const minutes = old.timer?.everyMinutes;
      const expression = old.timer?.expression ?? (
        minutes !== undefined && Number.isInteger(minutes) && minutes > 0 && minutes <= 59
          ? `*/${minutes} * * * *` : undefined
      );
      return decodeNode({ ...labelled, kind: "cron", expression });
    }
    case "watcher": return decodeNode({
      ...labelled, kind: "watcher", ...present("key", old.watch?.key),
      ...present("stat", old.watch?.stat), ...present("op", old.watch?.op), ...present("value", old.watch?.value),
    });
    case "label": return decodeNode({ ...base, kind: "label", text });
    case "git": return decodeNode({ ...labelled, kind: "git", cwd: old.git?.cwd });
    default:
      if (old?.entity?.kind === undefined && row.type === "file") return decodeNode({
        ...base, kind: "file", path: row.file_path, ...present("subpath", row.file_subpath),
      });
      if (old?.entity?.kind === undefined && row.type === "link") return decodeNode({
        ...base, kind: "link", url: row.link_url ?? "",
      });
      return decodeNode({ ...base, kind: "note", text });
  }
};

const decodeGrid = Schema.decodeUnknownSync(SheetGrid);

/** What an old sheet row held, or nothing when the row is not a sheet. */
export const sheetGridFromLegacyRow = (row: LegacyNodeRow): SheetGrid | undefined => {
  const old = row.ether_json == null ? undefined : decodeExtension(row.ether_json);
  if (old?.entity?.kind !== "sheet") return undefined;
  return decodeGrid({ columns: old.sheet?.columns ?? [], rows: old.sheet?.rows ?? [] });
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
    id: row.edge_id, from: row.from_node_id, to: row.to_node_id,
    ...old, ...present("fromSide", row.from_side), ...present("toSide", row.to_side),
  });
};
