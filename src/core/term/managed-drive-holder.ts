import type { ManagedTerminalDrive } from "./drive";

let held: ManagedTerminalDrive | undefined;

/** Process-local holder so overseer native uses the same drive as renderer IPC. */
export const bindManagedTerminalDriveForOverseer = (
  drive: ManagedTerminalDrive,
): void => {
  held = drive;
};

export const managedTerminalDriveForOverseer = ():
  | Pick<ManagedTerminalDrive, "writePrompt" | "interrupt">
  | undefined => held;
