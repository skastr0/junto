import { createConnection } from "node:net";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { resolveJuntoHome } from "@shared/junto-home";

/** Stream relay only. The core admits the peer and owns every frame. */
export const relayMachineLink = (
  path: string,
  input: Readable,
  output: Writable,
): Promise<void> => new Promise((resolve, reject) => {
  const socket = createConnection({ path, allowHalfOpen: true });
  let failure: Error | undefined;
  const failed = (cause: Error): void => { failure ??= cause; socket.destroy(); };
  const eof = (): void => { socket.end(); };
  const remoteEof = (): void => { socket.end(); };
  input.on("error", failed);
  output.on("error", failed);
  socket.on("error", failed);
  input.on("end", eof);
  socket.on("end", remoteEof);
  socket.once("connect", () => {
    input.pipe(socket, { end: false });
    socket.pipe(output, { end: false });
    if (input.readableEnded) eof();
  });
  socket.once("close", () => {
    input.unpipe(socket);
    socket.unpipe(output);
    input.pause();
    input.removeListener("error", failed);
    output.removeListener("error", failed);
    input.removeListener("end", eof);
    if (failure !== undefined) reject(failure); else resolve();
  });
});

export const runMachineLink = async (args: ReadonlyArray<string>): Promise<void> => {
  if (args.length !== 0) {
    process.stderr.write("junto link takes no arguments\n");
    process.exitCode = 64;
    return;
  }
  try { await relayMachineLink(join(resolveJuntoHome(), ".junto/core/control.sock"), process.stdin, process.stdout); }
  catch (cause) {
    process.stderr.write(`junto link: ${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  }
};
