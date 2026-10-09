export const MACHINE_PAYLOAD_MACHO_PATHS: ReadonlyArray<string>;
export const isMachinePayloadPath: (appPath: string, filePath: string) => boolean;
export interface MachinePayloadSnapshotFile {
  readonly path: string;
  readonly mode: number;
  readonly sha256: string;
}
export declare const snapshotMachinePayloads: (appPath: string) => Promise<MachinePayloadSnapshotFile[]>;
export declare const assertMachinePayloadsUnchanged: (before: MachinePayloadSnapshotFile[], after: MachinePayloadSnapshotFile[]) => void;
