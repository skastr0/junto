import { execFile } from "node:child_process";
import { userInfo } from "node:os";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** One absolute-path command runner; tests inject a double. */
export type MachineCommandRun = (command: string, args: string[]) => Promise<string>;

const defaultRun: MachineCommandRun = async (command, args) =>
  (await exec(command, args, { timeout: 10_000, maxBuffer: 64 * 1024 })).stdout;

const ownUid = (): number => process.getuid?.() ?? userInfo().uid;

/** Linger as a status channel may report it: proven, proven off, or unproven. */
export type MachineLingerState = "yes" | "no" | "unknown";

/** Read-only linger state for one uid; any failure is unknown, never a guess. */
export const probeMachineUserLinger = async (
  run: MachineCommandRun = defaultRun,
  uid: number = ownUid(),
): Promise<MachineLingerState> => {
  try {
    const output = await run("/usr/bin/loginctl", ["show-user", String(uid), "-p", "Linger"]);
    const match = /^Linger=(yes|no)[ \t]*$/m.exec(output);
    if (match === null) return "unknown";
    return match[1] === "yes" ? "yes" : "no";
  } catch {
    return "unknown";
  }
};

/** Enables linger for this user only, never through sudo; true only when confirmed. */
export const enableMachineUserLinger = async (
  run: MachineCommandRun = defaultRun,
  uid: number = ownUid(),
): Promise<boolean> => {
  if (await probeMachineUserLinger(run, uid) === "yes") return true;
  try {
    await run("/usr/bin/loginctl", ["enable-linger", String(uid)]);
  } catch {
    return false;
  }
  return await probeMachineUserLinger(run, uid) === "yes";
};
