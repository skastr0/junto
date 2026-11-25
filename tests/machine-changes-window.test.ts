/**
 * The window hears that what `machine.list` answers may have changed
 * (docs/machines.md, The window): the core publishes `machinesChanged` on the
 * push bus, one push per turn of notes, and main relays it to the window,
 * which reads the list again. Before, only the phone companion heard it.
 */
import { readFileSync } from "node:fs";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { CORE_PUSHES } from "../src/contract/core/channels";
import { noteMachinesChanged } from "../src/core/hosts/machine-changes";
import { publishMachinesChanged } from "../src/core/hosts/machine-pushes";
import { IPC_CHANNELS } from "../src/shared/ipc";

const heard = () => {
  const pushes: Array<{ readonly channel: string; readonly payload: unknown }> = [];
  const turns: Array<() => void> = [];
  const stop = publishMachinesChanged({ publish: (channel, payload) => Effect.sync(() => { pushes.push({ channel, payload }); }) }, (run) => { turns.push(run); });
  const turn = () => { for (const run of turns.splice(0)) run(); };
  return { pushes, turn, stop };
};

it("a turn of machine changes is one push, with nothing in it", () => {
  const { pushes, turn, stop } = heard();
  noteMachinesChanged(); noteMachinesChanged(); noteMachinesChanged();
  expect(pushes).toEqual([]);
  turn();
  expect(pushes).toEqual([{ channel: "junto:machines-changed", payload: {} }]);
  noteMachinesChanged();
  turn();
  expect(pushes).toHaveLength(2);
  stop();
});

it("a stopped publisher sends nothing, not even a push already queued", () => {
  const { pushes, turn, stop } = heard();
  noteMachinesChanged();
  stop();
  turn();
  noteMachinesChanged();
  turn();
  expect(pushes).toEqual([]);
});

it("the channel is on the core bus, published by every core with a window, and relayed by main", () => {
  expect(IPC_CHANNELS.machinesChanged).toBe("junto:machines-changed");
  expect(Object.keys(CORE_PUSHES)).toContain(IPC_CHANNELS.machinesChanged);
  expect(readFileSync("src/core/core.ts", "utf8")).toContain("stopMachinePushes = publishMachinesChanged(pushes)");
  const relay = readFileSync("src/app/ipc.ts", "utf8");
  const relayed = relay.slice(relay.indexOf("for (const channel of ["), relay.indexOf("]) onCorePush(channel"));
  expect(relayed).toContain("IPC_CHANNELS.machinesChanged,");
});
