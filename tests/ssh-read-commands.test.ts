import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { inspectRemoteCommand } from "../src/main/junto/ssh/domain";
import { remoteCat, remoteUname } from "../src/main/junto/ssh/read-commands";

describe("SSH read commands", () => {
  it("keeps named commands as argv", () => {
    expect(inspectRemoteCommand(Effect.runSync(remoteUname()))).toEqual({ executable: "/usr/bin/uname", args: ["-s"] });
    expect(inspectRemoteCommand(Effect.runSync(remoteCat("/home/operator/.junto/term/token")))).toEqual({ executable: "/bin/cat", args: ["/home/operator/.junto/term/token"] });
  });
  it.each(["relative", "/home/../token", "/home/a\n", "/home/a;bad"])("rejects unsafe read path %s", (path) => {
    expect(Effect.runSync(Effect.result(remoteCat(path)))._tag).toBe("Failure");
  });
});
