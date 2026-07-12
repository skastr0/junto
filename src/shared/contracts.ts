import { Schema } from "effect";

export const ServiceHealth = Schema.Literal("ok", "warning", "error", "unknown");
export type ServiceHealth = typeof ServiceHealth.Type;

export const ServiceCheck = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  status: ServiceHealth,
  detail: Schema.String,
  metadata: Schema.optionalWith(Schema.Record({ key: Schema.String, value: Schema.String }), {
    exact: true,
  }),
});
export type ServiceCheck = typeof ServiceCheck.Type;

export const StationInfo = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  userDataPath: Schema.String,
  stationPluginPath: Schema.String,
  prismRoot: Schema.String,
});
export type StationInfo = typeof StationInfo.Type;

export const DoctorReport = Schema.Struct({
  checkedAt: Schema.String,
  station: StationInfo,
  services: Schema.Array(ServiceCheck),
  recommendations: Schema.Array(Schema.String),
});
export type DoctorReport = typeof DoctorReport.Type;

export const DirectoryEntry = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  kind: Schema.Literal("file", "directory"),
  size: Schema.Number,
  modifiedAt: Schema.String,
});
export type DirectoryEntry = typeof DirectoryEntry.Type;

export const FolderSnapshot = Schema.Struct({
  root: Schema.String,
  entries: Schema.Array(DirectoryEntry),
});
export type FolderSnapshot = typeof FolderSnapshot.Type;
