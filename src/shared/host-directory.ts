import { Schema } from "effect";

export const HostDirectoryEntry = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  kind: Schema.Literals(["file", "directory"]),
  size: Schema.Number,
  modifiedAt: Schema.String,
});
export type HostDirectoryEntry = typeof HostDirectoryEntry.Type;

/**
 * One bounded, read-only directory page resolved on the selected host.
 * `root` is canonical and absolute on that host; `parent` is absent at the
 * filesystem root.
 */
export const HostDirectorySnapshot = Schema.Struct({
  root: Schema.String,
  parent: Schema.optionalKey(Schema.String),
  entries: Schema.Array(HostDirectoryEntry),
});
export type HostDirectorySnapshot = typeof HostDirectorySnapshot.Type;
