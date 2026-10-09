import { existsSync } from "node:fs";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Result } from "effect";
import { expect, it } from "vitest";
import { startCore } from "../src/main/junto/core";
import { coreControlSocketPath } from "../src/main/junto/link/listener";
import { CURRENT_STATE_SCHEMA_VERSION } from "../src/main/junto/state/migrations";
import { decodeOperatorResponse, encodeOperatorFrame, operatorControlSocketPath } from "../src/shared/operator-control";

it("starts the core in a fresh home and answers machine.status through real owner admission", async () => {
  const home = await mkdtemp("/tmp/junto-core-");
  const build = "a".repeat(64);
  let core: Awaited<ReturnType<typeof startCore>> | undefined;
  try {
    core = await startCore({ home, build, bundles: {}, peerPidHelperRoots: [resolve("scripts")] });
    expect(core.ready()).toBe(true);
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(operatorControlSocketPath(home));
      let response = "";
      socket.setEncoding("utf8");
      socket.once("connect", () => socket.write(encodeOperatorFrame({
        protocol: "junto-operator/v1", id: "boot-status", op: "machine.status", args: {},
      })));
      socket.on("data", chunk => { response += chunk; });
      socket.once("error", reject);
      socket.once("end", () => { socket.destroy(); resolve(response); });
    });
    const response = decodeOperatorResponse(JSON.parse(raw));
    expect(Result.isSuccess(response)).toBe(true);
    if (Result.isFailure(response)) throw new Error(response.failure.message);
    expect(response.success).toMatchObject({
      ok: true, op: "machine.status", data: { build, juntoHome: home, pid: process.pid, ready: true },
    });
    const database = new DatabaseSync(join(home, ".junto/state/junto.db"), { readOnly: true });
    try {
      expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(CURRENT_STATE_SCHEMA_VERSION);
      expect(database.prepare("SELECT COUNT(*) AS count FROM canvases").get()?.count).toBe(0);
    } finally { database.close(); }
    for (const path of [operatorControlSocketPath(home), coreControlSocketPath(home)]) {
      expect((await lstat(path)).mode & 0o777).toBe(0o600);
    }
    await core.close();
    expect(core.ready()).toBe(false);
    expect(existsSync(operatorControlSocketPath(home))).toBe(false);
    expect(existsSync(coreControlSocketPath(home))).toBe(false);
  } finally {
    await core?.close();
    await rm(home, { recursive: true, force: true });
  }
});
