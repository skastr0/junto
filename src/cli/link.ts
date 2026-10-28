import { createConnection } from "node:net";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { Schema } from "effect";
import { InstallationId } from "@shared/installation-id";
import { resolveJuntoHome } from "@shared/junto-home";

/**
 * Stream relay only. The core admits the peer and owns every frame. A relay
 * run by a link key's forced command names the opener that key is bound to:
 * it says so in one first line, before any byte from the far end, and the
 * core admits only a hello from that installation.
 */
export const relayMachineLink = (
  path: string,
  input: Readable,
  output: Writable,
  opener?: InstallationId,
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
    if (opener !== undefined) socket.write(`${JSON.stringify({ type: "opener", installationId: opener })}\n`);
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

const isInstallationId = Schema.is(InstallationId);

/**
 * `junto link` or `junto link --opener <installation id>`. The opener comes
 * from argv alone, as the forced command wrote it: never SSH_ORIGINAL_COMMAND
 * or an environment value the far end could send.
 */
export const runMachineLink = async (args: ReadonlyArray<string>): Promise<void> => {
  const opener = args.length === 2 && args[0] === "--opener" && isInstallationId(args[1]) ? args[1] : undefined;
  if (args.length !== 0 && opener === undefined) {
    process.stderr.write("junto link takes no arguments, or --opener <installation id>\n");
    process.exitCode = 64;
    return;
  }
  try { await relayMachineLink(join(resolveJuntoHome(), ".junto/core/control.sock"), process.stdin, process.stdout, opener); }
  catch (cause) {
    process.stderr.write(`junto link: ${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  }
};
