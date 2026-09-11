import { createServer, type Server } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  encodeWorkFrame,
  workErr,
  workOk,
} from "../src/shared/work-control";
import { handshakeLinuxWorkControl } from "../src/main/vellum-command/hosts/host-runtime-platform";

const listen = async (
  path: string,
  reply: (line: string) => string | undefined,
): Promise<Server> =>
  await new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      let buf = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        const nl = buf.indexOf(0x0a);
        if (nl < 0) return;
        const line = buf.subarray(0, nl).toString("utf8");
        const body = reply(line);
        if (body !== undefined) socket.write(body);
      });
    });
    server.on("error", reject);
    server.listen(path, () => resolve(server));
  });

describe("Linux work-control handshake", () => {
  let dir = "";
  let server: Server | undefined;

  afterEach(async () => {
    server?.close();
    server = undefined;
    if (dir.length > 0) await rm(dir, { recursive: true, force: true });
    dir = "";
  });

  it("is up when the daemon returns a well-formed envelope", async () => {
    dir = await mkdtemp(join(tmpdir(), "vellum-work-attach-"));
    const sock = join(dir, "control.sock");
    server = await listen(sock, () =>
      encodeWorkFrame(workErr("AuthError", "process unbound")),
    );
    await expect(handshakeLinuxWorkControl(sock, "token", 500)).resolves.toBe(
      "up",
    );
  });

  it("is up on a successful ping", async () => {
    dir = await mkdtemp(join(tmpdir(), "vellum-work-attach-"));
    const sock = join(dir, "control.sock");
    server = await listen(sock, () =>
      encodeWorkFrame(workOk("ping", { pong: true })),
    );
    await expect(handshakeLinuxWorkControl(sock, "token", 500)).resolves.toBe(
      "up",
    );
  });

  it("is down when nothing accepts the connect", async () => {
    dir = await mkdtemp(join(tmpdir(), "vellum-work-attach-"));
    await expect(
      handshakeLinuxWorkControl(join(dir, "missing.sock"), "token", 200),
    ).resolves.toBe("down");
  });

  it("is unknown when the socket speaks garbage", async () => {
    dir = await mkdtemp(join(tmpdir(), "vellum-work-attach-"));
    const sock = join(dir, "control.sock");
    server = await listen(sock, () => "not-json\n");
    await expect(handshakeLinuxWorkControl(sock, "token", 500)).resolves.toBe(
      "unknown",
    );
  });
});
