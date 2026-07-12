import { observable } from "@legendapp/state";
import type { DirectoryEntry, DoctorReport, ServiceCheck } from "@shared/contracts";

export const appState$ = observable({
  doctor: null as DoctorReport | null,
  folderRoot: "",
  folderEntries: [] as ReadonlyArray<DirectoryEntry>,
  codexProbe: null as ServiceCheck | null,
  prismDryRun: null as ServiceCheck | null,
  busy: false,
  error: "",
});
