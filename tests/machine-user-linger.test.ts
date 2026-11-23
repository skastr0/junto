import { describe, expect, it } from "vitest";
import { enableMachineUserLinger, probeMachineUserLinger, type MachineCommandRun } from "../src/node/hosts/linger";

const uid = 501;
const runReturning = (output: string | Error, calls?: string[][]): MachineCommandRun =>
  async (command, args) => {
    calls?.push([command, ...args]);
    if (output instanceof Error) throw output;
    return output;
  };

describe("machine user linger", () => {
  it("reads yes, no and unknown from loginctl without guessing", async () => {
    await expect(probeMachineUserLinger(runReturning("Linger=yes\n"), uid)).resolves.toBe("yes");
    await expect(probeMachineUserLinger(runReturning("Linger=no\n"), uid)).resolves.toBe("no");
    await expect(probeMachineUserLinger(runReturning("Linger=\n"), uid)).resolves.toBe("unknown");
    await expect(probeMachineUserLinger(runReturning("not a property\n"), uid)).resolves.toBe("unknown");
    await expect(probeMachineUserLinger(runReturning(new Error("no loginctl")), uid)).resolves.toBe("unknown");
  });

  it("enables linger for the own uid and confirms the manager state", async () => {
    const calls: string[][] = [];
    let linger = "no";
    const run: MachineCommandRun = async (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === "enable-linger") { linger = "yes"; return ""; }
      return `Linger=${linger}\n`;
    };
    await expect(enableMachineUserLinger(run, uid)).resolves.toBe(true);
    expect(calls).toEqual([
      ["/usr/bin/loginctl", "show-user", String(uid), "-p", "Linger"],
      ["/usr/bin/loginctl", "enable-linger", String(uid)],
      ["/usr/bin/loginctl", "show-user", String(uid), "-p", "Linger"],
    ]);
  });

  it("does not re-enable an already confirmed linger", async () => {
    const calls: string[][] = [];
    await expect(enableMachineUserLinger(runReturning("Linger=yes\n", calls), uid)).resolves.toBe(true);
    expect(calls).toEqual([["/usr/bin/loginctl", "show-user", String(uid), "-p", "Linger"]]);
  });

  it("fails closed when enable or verification fails", async () => {
    await expect(enableMachineUserLinger(runReturning(new Error("no loginctl")), uid)).resolves.toBe(false);
    const stuck: MachineCommandRun = async (_command, args) =>
      args[0] === "enable-linger" ? "" : "Linger=no\n";
    await expect(enableMachineUserLinger(stuck, uid)).resolves.toBe(false);
  });
});
