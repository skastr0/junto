import { terminalBindingOf } from "../src/shared/terminal";
import { note, seat, terminal } from "./support/model-nodes";
import { describe, expect, it } from "vitest";
import { xtermCapabilities } from "../src/shared/terminal";

it("exposes the xterm presentation", () => {
  expect(xtermCapabilities().presentation).toBe("xterm");
});

describe("the binding of a node as the model holds it", () => {
  it("a seat and a raw terminal have one, and nothing else does", () => {
    const worker = seat("worker", { host: "remote-a" as never, bindingId: "bind-w" as never, harness: "codex" });
    expect(terminalBindingOf(worker)).toEqual({
      kind: "native",
      hostId: "remote-a",
      bindingId: "bind-w",
      onDelete: "detach",
      label: "worker",
      harness: "codex",
      agentKey: "local:worker",
    });
    const shell = terminal("shell");
    expect(terminalBindingOf(shell)).toMatchObject({ kind: "native", bindingId: shell.bindingId, hostId: shell.host });
    expect(terminalBindingOf(shell)?.harness).toBeUndefined();
    expect(terminalBindingOf(note("n"))).toBeUndefined();
    expect(terminalBindingOf(undefined)).toBeUndefined();
  });
});
