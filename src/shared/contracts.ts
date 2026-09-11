import { Schema } from "effect";
import { FleetPeerCompatibilitySnapshot } from "./fleet-compatibility-snapshot";

export const ServiceHealth = Schema.Literals(["ok", "warning", "error", "unknown"]);
export type ServiceHealth = typeof ServiceHealth.Type;

export const ServiceCheck = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  status: ServiceHealth,
  detail: Schema.String,
  metadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
export type ServiceCheck = typeof ServiceCheck.Type;

export const StationInfo = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  userDataPath: Schema.String,
});
export type StationInfo = typeof StationInfo.Type;

export const DoctorReport = Schema.Struct({
  checkedAt: Schema.String,
  station: StationInfo,
  services: Schema.Array(ServiceCheck),
  recommendations: Schema.Array(Schema.String),
  /** Main-owned local Remote compatibility snapshot for the station face. */
  fleetCompatibility: Schema.optionalKey(FleetPeerCompatibilitySnapshot),
});
export type DoctorReport = typeof DoctorReport.Type;
