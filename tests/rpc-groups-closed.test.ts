/**
 * Every Rpc of every group that crosses a process refuses excess keys.
 *
 * RpcServer and RpcClient read Rpc.ParseOptions from each Rpc's own
 * annotations (effect/dist/rpc/RpcServer.js:380, RpcClient.js:495). A group's
 * `.annotate(...)` sets only the group's annotations, so it never reaches a
 * call; `.annotateRpcs(...)` sets every Rpc's. This locks the second form for
 * all of them, so a group that drifts back fails here, not in a decode.
 */
import { Context } from "effect";
import { Rpc, type RpcGroup } from "effect/rpc";
import { describe, expect, it } from "vitest";
import { CoreRpcs } from "../src/contract/core/rpcs";
import { HostRpcs } from "../src/contract/host/rpcs";
import { TerminalRpcs } from "../src/contract/terminal/rpcs";
import { WindowRpcs } from "../src/contract/window/rpcs";
import { MsgRpcs } from "../src/contract/work/msg";

const groups: ReadonlyArray<readonly [string, RpcGroup.RpcGroup<Rpc.Any>]> = [
  ["CoreRpcs", CoreRpcs],
  ["HostRpcs", HostRpcs],
  ["TerminalRpcs", TerminalRpcs],
  ["WindowRpcs", WindowRpcs],
  ["MsgRpcs", MsgRpcs],
];

describe("rpc groups are closed", () => {
  for (const [name, group] of groups) {
    it(`${name}: every Rpc decodes with onExcessProperty "error"`, () => {
      const open = [...group.requests.values()]
        .filter((rpc) => Context.get(rpc.annotations, Rpc.ParseOptions).onExcessProperty !== "error")
        .map((rpc) => rpc._tag);
      expect(group.requests.size).toBeGreaterThan(0);
      expect(open).toEqual([]);
    });
  }
});
