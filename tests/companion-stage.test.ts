/**
 * `content.stage` on the phone path: the protocol half in companion-core
 * (offsets, the declared size, the per-phone count, what unpairing lets go)
 * over a stager that keeps pieces in memory, and the bounded stdin reader.
 */
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { boundedLines } from "../src/cli/companion-stdio";
import {
  handleCompanionRequest,
  makeCompanionGates,
  outcomeFail,
  outcomeOk,
  releaseCompanionUploads,
  type CompanionBackend,
} from "../src/shared/companion-core";
import type { ContentStageArgs, ContentStageResult } from "../src/shared/content-stage";
import { COMPANION_PROTOCOL, type CompanionRequestFrame, type CompanionResponseFrame } from "../src/shared/companion-protocol";
import type { ContentRef } from "../src/shared/wire/content-ref";

type Open = { bytes: Buffer[] };

const stagingBackend = () => {
  const open = new Map<string, Open>();
  const dropped: string[] = [];
  const admitted: number[] = [];
  let next = 0;
  let diskLow = false;
  const backend = {
    now: () => 1_000,
    stagePiece: async (_canvas: string, args: ContentStageArgs) => {
      const stageId = args.stageId ?? `stg_${String(next++).padStart(32, "0")}`;
      const stage = open.get(stageId) ?? { bytes: [] };
      if (args.stageId !== undefined && !open.has(stageId)) return outcomeFail<ContentStageResult>("invalid", "gone");
      open.set(stageId, stage);
      if (args.bytesBase64 !== undefined) stage.bytes.push(Buffer.from(args.bytesBase64, "base64"));
      const whole = Buffer.concat(stage.bytes);
      if (args.done === undefined) return outcomeOk<ContentStageResult>({ stageId, byteLength: whole.length } as ContentStageResult);
      open.delete(stageId);
      const sha256 = createHash("sha256").update(whole).digest("hex");
      if (args.done.expected && (args.done.expected.sha256 !== sha256 || args.done.expected.byteLength !== whole.length)) {
        return outcomeFail<ContentStageResult>("mismatch");
      }
      return outcomeOk<ContentStageResult>({
        ref: { sha256, byteLength: whole.length, mediaType: args.done.mediaType } as ContentRef,
      });
    },
    admitStage: async (_canvas: string, byteLength: number) => {
      admitted.push(byteLength);
      return diskLow ? outcomeFail<void>("disk-low") : outcomeOk(undefined);
    },
    dropStaged: async (_canvas: string, stageId: string) => {
      dropped.push(stageId);
      open.delete(stageId);
    },
  } as unknown as CompanionBackend;
  return { backend, open, dropped, admitted, setDiskLow: (low: boolean) => (diskLow = low) };
};

const file = (size: number): { readonly bytes: Buffer; readonly sha256: string } => {
  const bytes = Buffer.alloc(size, 0);
  for (let i = 0; i < size; i += 1) bytes[i] = (i * 31) % 251;
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
};

const session = () => {
  const store = stagingBackend();
  const gates = makeCompanionGates();
  let n = 0;
  const send = (args: Record<string, unknown>): Promise<CompanionResponseFrame> =>
    handleCompanionRequest(
      { v: COMPANION_PROTOCOL, type: "request", id: `r${String(n++)}`, op: "content.stage", args } as CompanionRequestFrame,
      { backend: store.backend, device: { deviceId: "dev_x", state: "paired" }, allowWrite: () => true, allowArtifactWrite: () => true, gates },
    );
  const piece = (f: ReturnType<typeof file>, offset: number, length: number) =>
    send({
      canvasName: "main",
      sha256: f.sha256,
      byteLength: f.bytes.length,
      mediaType: "image/png",
      displayName: "shot.png",
      offset,
      data: f.bytes.subarray(offset, offset + length).toString("base64"),
    });
  return { ...store, gates, send, piece };
};

const result = (frame: CompanionResponseFrame) => (frame.ok ? (frame.result as Record<string, unknown>) : undefined);
const code = (frame: CompanionResponseFrame) => (frame.ok ? undefined : frame.error.code);

describe("content.stage on the phone path", () => {
  it("takes a file in pieces, in order, and answers its ref on the last byte", async () => {
    const s = session();
    const f = file(10);
    expect(result(await s.piece(f, 0, 4))).toEqual({ received: 4 });
    expect(result(await s.piece(f, 4, 4))).toEqual({ received: 8 });
    expect(result(await s.piece(f, 8, 2))).toEqual({ ref: { sha256: f.sha256, byteLength: 10, mediaType: "image/png" } });
    // Disk is asked once, for the whole declared size, before the first piece.
    expect(s.admitted).toEqual([10]);
    expect(s.gates.uploads.open.size).toBe(0);
    expect(s.gates.uploads.finished).toHaveLength(1);
  });

  it("takes a one-piece file", async () => {
    const s = session();
    const f = file(3);
    expect(result(await s.piece(f, 0, 3))).toMatchObject({ ref: { sha256: f.sha256, byteLength: 3 } });
  });

  it("refuses a piece out of order, and one that runs past the declared size", async () => {
    const s = session();
    const f = file(10);
    expect(code(await s.piece(f, 4, 4))).toBe("invalid");
    await s.piece(f, 0, 4);
    expect(code(await s.piece(f, 6, 2))).toBe("invalid");
    const longer = { ...f, bytes: Buffer.concat([f.bytes, Buffer.alloc(4)]) };
    expect(code(await s.send({ canvasName: "main", sha256: f.sha256, byteLength: 10, mediaType: "image/png", offset: 8, data: longer.bytes.subarray(8, 14).toString("base64") }))).toBe("invalid");
  });

  it("starts over at offset 0, dropping the upload already open for that file", async () => {
    const s = session();
    const f = file(10);
    await s.piece(f, 0, 4);
    const [first] = [...s.open.keys()];
    expect(result(await s.piece(f, 0, 4))).toEqual({ received: 4 });
    expect(s.dropped).toEqual([first]);
    expect(s.gates.uploads.open.size).toBe(1);
  });

  it("refuses bytes that do not hash to what the phone named", async () => {
    const s = session();
    const f = file(6);
    const lie = { ...f, sha256: "c".repeat(64) };
    await s.piece(lie, 0, 3);
    expect(code(await s.piece(lie, 3, 3))).toBe("mismatch");
    expect(s.gates.uploads.open.size).toBe(0);
  });

  it("refuses at offset 0 when the disk cannot hold the declared size", async () => {
    const s = session();
    s.setDiskLow(true);
    expect(code(await s.piece(file(10), 0, 4))).toBe("disk-low");
    expect(s.open.size).toBe(0);
  });

  it("holds at most ten uploads open per phone", async () => {
    const s = session();
    for (let i = 0; i < 10; i += 1) expect(result(await s.piece(file(20 + i), 0, 4))).toEqual({ received: 4 });
    expect(code(await s.piece(file(40), 0, 4))).toBe("rate-limited");
  });

  it("lets go of every open and finished upload when the phone is unpaired", async () => {
    const s = session();
    await s.piece(file(10), 0, 4);
    await s.piece(file(3), 0, 3);
    await releaseCompanionUploads(s.backend, s.gates.uploads);
    expect(s.dropped).toHaveLength(2);
    expect(s.gates.uploads.open.size).toBe(0);
    expect(s.gates.uploads.finished).toEqual([]);
  });
});

describe("the companion stdin reader", () => {
  const read = async (chunks: ReadonlyArray<string>, max: number) => {
    let overflowed = false;
    const lines: string[] = [];
    for await (const line of boundedLines(Readable.from(chunks.map((c) => Buffer.from(c))), max, () => (overflowed = true))) {
      lines.push(line);
    }
    return { lines, overflowed };
  };

  it("splits lines across chunks", async () => {
    expect(await read(["ab", "c\nde", "f\n", "g"], 16)).toEqual({ lines: ["abc", "def", "g"], overflowed: false });
  });

  it("stops at the cap without buffering the rest of the line", async () => {
    expect(await read(["12345\n", "1234567", "89"], 8)).toEqual({ lines: ["12345"], overflowed: true });
    // A line exactly at the cap, newline counted, is taken.
    expect(await read(["1234567\n"], 8)).toEqual({ lines: ["1234567"], overflowed: false });
  });
});
