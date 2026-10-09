import { Schema } from "effect";
import { Node, Wire, type Launch, type NodeKind } from "@shared/model";

export type SqlRow = Readonly<Record<string, unknown>>;
export type SqlValues = Record<string, string | number | null>;
const json = (value: unknown): string | null =>
  value === undefined ? null : JSON.stringify(value);
const optional = (row: SqlRow, column: string, field = column) =>
  row[column] === null || row[column] === undefined
    ? {}
    : { [field]: row[column] };
const readJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Unknown),
);
const optionalJson = (row: SqlRow, column: string, field: string) =>
  row[column] == null ? {} : { [field]: readJson(row[column]) };
const launchColumns = (launch: Launch | undefined): SqlValues => ({
  launch_kind: launch?.kind ?? null,
  launch_cwd: launch?.cwd ?? null,
  launch_argv_json: json(launch?.argv),
  launch_env_json: json(launch?.env),
  launch_extra_args_json: json(launch?.extraArgs),
});
const launchFromRow = (row: SqlRow) =>
  row.launch_kind == null
    ? {}
    : {
        launch: {
          kind: row.launch_kind,
          ...optional(row, "launch_cwd", "cwd"),
          ...optionalJson(row, "launch_argv_json", "argv"),
          ...optionalJson(row, "launch_env_json", "env"),
          ...optionalJson(row, "launch_extra_args_json", "extraArgs"),
        },
      };

/** Encode a validated domain row into named columns, never an opaque payload. */
export const nodeToRow = (canvas: string, node: Node): SqlValues => {
  const base: SqlValues = {
    canvas_name: canvas,
    id: node.id,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    z_index: node.z,
    color: node.color ?? null,
  };
  switch (node.kind) {
    case "peer":
      return { ...base, label: node.label, host: node.host, seat_id: node.seatId };
    case "agent":
      return {
        ...base,
        agent_key: node.agentKey,
        label: node.label,
        host: node.host,
        binding_id: node.bindingId,
        harness: node.harness,
        session_id: node.sessionId ?? null,
        on_remove: node.onRemove,
        overseer: Number(node.overseer),
        ...launchColumns(node.launch),
      };
    case "terminal":
      return {
        ...base,
        label: node.label ?? null,
        host: node.host,
        binding_id: node.bindingId,
        on_remove: node.onRemove,
        ...launchColumns(node.launch),
      };
    case "page":
      return {
        ...base,
        url: node.url,
        profile: node.profile,
        host: node.host,
        on_remove: node.onRemove,
      };
    case "task":
      return {
        ...base,
        name: node.name ?? null,
        contract_json: json(node.contract),
      };
    case "requests":
      return { ...base, name: node.name ?? null };
    case "artifacts":
    case "board":
    case "pad":
    case "sheet":
      return { ...base, label: node.label ?? null };
    case "relay":
      return { ...base, label: node.label ?? null, host: node.host };
    case "cron":
      return {
        ...base,
        label: node.label ?? null,
        host: node.host,
        expression: node.expression ?? null,
      };
    case "watcher":
      return {
        ...base,
        label: node.label ?? null,
        host: node.host,
        watch_key: node.key ?? null,
        stat: node.stat ?? null,
        op: node.op ?? null,
        value: node.value ?? null,
      };
    case "note":
    case "label":
      return { ...base, text: node.text };
    case "file":
      return { ...base, path: node.path, subpath: node.subpath ?? null };
    case "link":
      return { ...base, url: node.url };
    case "git":
      return { ...base, label: node.label ?? null, cwd: node.cwd };
    case "region":
      return {
        ...base,
        label: node.label ?? null,
        hold: Number(node.hold),
        instruction: node.instruction ?? null,
        page_url: node.defaults?.page?.url ?? null,
        page_profile: node.defaults?.page?.profile ?? null,
        page_host: node.defaults?.page?.host ?? null,
        paths_json: json(node.defaults?.paths),
        rules_json: json(node.contract?.rules),
        rulings_json: json(node.contract?.rulings),
        environment_json: json(node.environment),
        background: node.background ?? null,
        background_style: node.backgroundStyle ?? null,
      };
  }
};

/** SQL decode ends at the same closed schema used at the command boundary. */
export const nodeFromRow = (kind: NodeKind, row: SqlRow): Node => {
  const base = {
    kind,
    id: row.id,
    x: row.x,
    y: row.y,
    width: row.width,
    height: row.height,
    z: row.z_index,
    ...optional(row, "color"),
  };
  const label = optional(row, "label");
  let fields: object;
  switch (kind) {
    case "peer":
      fields = { label: row.label, host: row.host, seatId: row.seat_id };
      break;
    case "agent":
      fields = {
        agentKey: row.agent_key,
        label: row.label,
        host: row.host,
        bindingId: row.binding_id,
        harness: row.harness,
        onRemove: row.on_remove,
        overseer: row.overseer === 1,
        ...optional(row, "session_id", "sessionId"),
        ...launchFromRow(row),
      };
      break;
    case "terminal":
      fields = {
        ...label,
        host: row.host,
        bindingId: row.binding_id,
        onRemove: row.on_remove,
        ...launchFromRow(row),
      };
      break;
    case "page":
      fields = {
        url: row.url,
        profile: row.profile,
        host: row.host,
        onRemove: row.on_remove,
      };
      break;
    case "task":
      fields = {
        ...optional(row, "name"),
        ...optionalJson(row, "contract_json", "contract"),
      };
      break;
    case "requests":
      fields = optional(row, "name");
      break;
    case "artifacts":
    case "board":
    case "pad":
    case "sheet":
      fields = label;
      break;
    case "relay":
      fields = { ...label, host: row.host };
      break;
    case "cron":
      fields = { ...label, host: row.host, ...optional(row, "expression") };
      break;
    case "watcher":
      fields = {
        ...label,
        host: row.host,
        ...optional(row, "watch_key", "key"),
        ...optional(row, "stat"),
        ...optional(row, "op"),
        ...optional(row, "value"),
      };
      break;
    case "note":
    case "label":
      fields = { text: row.text };
      break;
    case "file":
      fields = { path: row.path, ...optional(row, "subpath") };
      break;
    case "link":
      fields = { url: row.url };
      break;
    case "git":
      fields = { ...label, cwd: row.cwd };
      break;
    case "region":
      fields = {
        ...label,
        hold: row.hold === 1,
        ...optional(row, "instruction"),
        ...([
          row.page_url,
          row.page_profile,
          row.page_host,
          row.paths_json,
        ].some((value) => value != null)
          ? {
              defaults: {
                ...([row.page_url, row.page_profile, row.page_host].some(
                  (value) => value != null,
                )
                  ? {
                      page: {
                        ...optional(row, "page_url", "url"),
                        ...optional(row, "page_profile", "profile"),
                        ...optional(row, "page_host", "host"),
                      },
                    }
                  : {}),
                ...optionalJson(row, "paths_json", "paths"),
              },
            }
          : {}),
        ...([row.rules_json, row.rulings_json].some((value) => value != null)
          ? {
              contract: {
                ...optionalJson(row, "rules_json", "rules"),
                ...optionalJson(row, "rulings_json", "rulings"),
              },
            }
          : {}),
        ...optionalJson(row, "environment_json", "environment"),
        ...optional(row, "background"),
        ...optional(row, "background_style", "backgroundStyle"),
      };
      break;
  }
  return Schema.decodeUnknownSync(Node)(
    { ...base, ...fields },
    { onExcessProperty: "error" },
  );
};

export const wireToRow = (canvas: string, wire: Wire): SqlValues => ({
  canvas_name: canvas,
  id: wire.id,
  from_id: wire.from,
  to_id: wire.to,
  verb: wire.verb,
  from_side: wire.fromSide ?? null,
  to_side: wire.toSide ?? null,
  mask_json: json(wire.mask),
});
export const wireFromRow = (row: SqlRow): Wire =>
  Schema.decodeUnknownSync(Wire)({
    id: row.id,
    from: row.from_id,
    to: row.to_id,
    verb: row.verb,
    ...optional(row, "from_side", "fromSide"),
    ...optional(row, "to_side", "toSide"),
    ...optionalJson(row, "mask_json", "mask"),
  });
