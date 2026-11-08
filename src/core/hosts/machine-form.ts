import { Effect } from "effect";
import type { MachineForm } from "@shared/machine-control";
import { runCli } from "../adapters/exec";

// Apple model identifier tables, checked 2026-10-09:
// https://support.apple.com/en-us/102852 (mini)
// https://support.apple.com/en-us/102231 (Studio)
// https://support.apple.com/en-us/108052 (MacBook Pro)
// https://support.apple.com/en-us/102869 (MacBook Air)
const mini = new Set(["Mac14,3", "Mac14,12", "Mac16,10", "Mac16,11", "Mac17,16", "Mac18,5"]);
const studio = new Set(["Mac13,1", "Mac13,2", "Mac14,13", "Mac14,14", "Mac15,14", "Mac16,9", "Mac17,14", "Mac17,15"]);
const macbook = new Set([
  "Mac14,2", "Mac14,5", "Mac14,6", "Mac14,7", "Mac14,9", "Mac14,10", "Mac14,15",
  "Mac15,3", "Mac15,6", "Mac15,7", "Mac15,8", "Mac15,9", "Mac15,10", "Mac15,11", "Mac15,12", "Mac15,13",
  "Mac16,1", "Mac16,5", "Mac16,6", "Mac16,7", "Mac16,8", "Mac16,12", "Mac16,13",
  "Mac17,2", "Mac17,3", "Mac17,4", "Mac17,6", "Mac17,7", "Mac17,8", "Mac17,9",
]);

/** Unknown Mac identifiers retain the generic Mac form. Raw identifiers stay local. */
export const classifyMachineForm = (platform: string, identifier: string): MachineForm => {
  if (platform !== "darwin") return "linux";
  const model = identifier.trim();
  if (/^MacBook(?:Air|Pro)?\d+,\d+$/.test(model) || macbook.has(model)) return "macbook";
  if (/^Macmini\d+,\d+$/.test(model) || mini.has(model)) return "mac-mini";
  if (studio.has(model)) return "mac-studio";
  return "mac";
};

/** Hardware detection uses the existing sealed read-only process adapter. */
export const detectMachineForm = (): Effect.Effect<MachineForm> => process.platform !== "darwin"
  ? Effect.succeed("linux")
  : Effect.promise(() => runCli("/usr/sbin/sysctl", ["-n", "hw.model"], 2_000)).pipe(
    Effect.map(result => classifyMachineForm("darwin", result.ok ? result.stdout : "")),
  );
