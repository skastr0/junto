/**
 * Packaged content-transfer entry — `vellum-command content-transfer …`.
 *
 * Same receive|send|stat closed argv as the old vellum-command-content helper, now a
 * subcommand of the single packaged CLI binary.
 */
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { resolveVellumCommandHome } from "../shared/vellum-home";
import {
  CONTENT_TRANSFER_COMMAND,
  parseContentHelperArgs,
} from "../main/vellum/content/helper-contract";
import { contentStoreRoot } from "../main/vellum/content/paths";
import {
  contentRefForTransfer,
  encodeContentHelperStatus,
  receiveContentTransfer,
  sendContentTransfer,
  statContentForTransfer,
} from "../main/vellum/content/transfer-local";
import { ContentStoreError } from "../main/vellum/content/store";

export { CONTENT_TRANSFER_COMMAND };

const stdinAsAsyncIterable = async function* (): AsyncGenerator<Buffer> {
  const readable = process.stdin as Readable;
  readable.resume();
  for await (const chunk of readable) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (buf.length > 0) yield buf;
  }
};

export const runContentTransfer = async (
  argv: ReadonlyArray<string>,
): Promise<void> => {
  const parsed = parseContentHelperArgs(argv);
  if ("exitCode" in parsed) {
    process.stderr.write(`vellum-command content-transfer: ${parsed.error}\n`);
    process.exitCode = parsed.exitCode;
    return;
  }

  const args = parsed;
  const root = contentStoreRoot(resolveVellumCommandHome());
  const ref = contentRefForTransfer({
    sha256: args.sha256,
    byteLength: args.byteLength,
  });

  try {
    if (args.mode === "stat") {
      const stat = statContentForTransfer(root, ref);
      if (stat.state === "verified") {
        process.stdout.write(
          encodeContentHelperStatus({
            ok: true,
            state: "verified",
            sha256: ref.sha256,
            byteLength: ref.byteLength,
            verifiedAt: stat.verifiedAt,
          }),
        );
        return;
      }
      if (stat.state === "partial") {
        process.stdout.write(
          encodeContentHelperStatus({
            ok: true,
            state: "partial",
            sha256: ref.sha256,
            byteLength: ref.byteLength,
            receivedBytes: stat.partialBytes,
          }),
        );
        return;
      }
      if (stat.state === "corrupt") {
        process.stdout.write(
          encodeContentHelperStatus({
            ok: true,
            state: "corrupt",
            sha256: ref.sha256,
            byteLength: ref.byteLength,
            reason: stat.reason,
            observedSha256: stat.observedSha256,
            observedByteLength: stat.observedByteLength,
          }),
        );
        process.exitCode = 1;
        return;
      }
      process.stdout.write(
        encodeContentHelperStatus({
          ok: true,
          state: "missing",
          sha256: ref.sha256,
          byteLength: ref.byteLength,
          reason: stat.reason,
        }),
      );
      return;
    }

    if (args.mode === "send") {
      const stat = statContentForTransfer(root, ref);
      if (stat.state !== "verified") {
        process.stderr.write(
          encodeContentHelperStatus({
            ok: false,
            error:
              stat.state === "missing"
                ? "content object is not available to send"
                : "content object is not verified for send",
          }),
        );
        process.exitCode = 1;
        return;
      }
      if (args.offset > 0) {
        const stream = createReadStream(stat.path, {
          start: args.offset,
          highWaterMark: 64 * 1024,
        });
        for await (const chunk of stream) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          if (buf.length === 0) continue;
          const ok = process.stdout.write(buf);
          if (!ok) {
            await new Promise<void>((resolve) =>
              process.stdout.once("drain", resolve),
            );
          }
        }
        return;
      }
      for await (const chunk of sendContentTransfer({
        root,
        ref,
        offset: args.offset,
      })) {
        const ok = process.stdout.write(chunk);
        if (!ok) {
          await new Promise<void>((resolve) =>
            process.stdout.once("drain", resolve),
          );
        }
      }
      return;
    }

    const result = await receiveContentTransfer({
      root,
      ref,
      source: stdinAsAsyncIterable(),
      expectedOffset: args.offset,
    });

    if (result.state === "verified") {
      process.stdout.write(
        encodeContentHelperStatus({
          ok: true,
          state: "verified",
          sha256: result.ref.sha256,
          byteLength: result.ref.byteLength,
          verifiedAt: result.verifiedAt,
          created: result.created,
        }),
      );
      return;
    }

    process.stdout.write(
      encodeContentHelperStatus({
        ok: true,
        state: "partial",
        sha256: result.ref.sha256,
        byteLength: result.ref.byteLength,
        receivedBytes: result.receivedBytes,
      }),
    );
    process.exitCode = 0;
  } catch (error) {
    const message =
      error instanceof ContentStoreError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    const dest = args.mode === "send" ? process.stderr : process.stdout;
    dest.write(
      encodeContentHelperStatus({
        ok: false,
        error: message.slice(0, 1024),
      }),
    );
    process.exitCode =
      error instanceof ContentStoreError && error.code === "corrupt" ? 2 : 1;
  }
};
