#!/usr/bin/env bun
/** Write the source-revision.json a Linux release bundle carries. */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_REVISION = /^[0-9a-f]{40}$/u;

export const sourceRevisionReceipt = (revision: string) => {
  if (!SOURCE_REVISION.test(revision)) {
    throw new Error("source revision must be a full lowercase commit id");
  }
  return { schema: "junto/source-revision/v1", revision } as const;
};

export const linuxReleaseSourceRevisionMain = async (
  args: ReadonlyArray<string>,
): Promise<void> => {
  const [revisionFlag, revision, outFlag, out, ...rest] = args;
  if (
    revisionFlag !== "--source-revision" ||
    outFlag !== "--source-out" ||
    revision === undefined ||
    out === undefined ||
    rest.length > 0
  ) {
    throw new Error(
      "usage: --source-revision <commit> --source-out <file>",
    );
  }
  const receipt = sourceRevisionReceipt(revision);
  const file = path.resolve(out);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o755 });
  await writeFile(file, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o644,
  });
  process.stdout.write(`${JSON.stringify({ ok: true, sourceRevision: revision })}\n`);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  linuxReleaseSourceRevisionMain(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown failure";
    process.stderr.write(`Linux release source revision failed: ${message}\n`);
    process.exitCode = 1;
  });
}
