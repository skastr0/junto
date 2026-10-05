import { describe, expect, it } from "vitest";
import { AGENT_SIGNAL_MAX_ATTACHMENT_BYTES } from "@shared/agent-signals";
import {
  admitSignalAttachments,
  attachmentName,
  signalAttachmentOwner,
} from "../src/main/junto/signals/attachments";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const file = (name: string, bytes: Buffer, caption?: string) => ({
  name,
  bytesBase64: bytes.toString("base64"),
  ...(caption === undefined ? {} : { caption }),
});

describe("admitSignalAttachments", () => {
  it("admits images and text in order, with their type and caption", () => {
    const admitted = admitSignalAttachments([
      file("before.png", PNG, "  Before  "),
      file("notes.md", Buffer.from("# hi")),
    ]);
    expect(admitted.ok && admitted.attachments.map(({ bytes: _bytes, ...rest }) => rest)).toEqual([
      { name: "before.png", mediaType: "image/png", caption: "Before" },
      { name: "notes.md", mediaType: "text/markdown" },
    ]);
  });

  it("keeps only the file name of whatever name it is given", () => {
    expect(attachmentName("/Users/me/shots/before.png")).toBe("before.png");
    expect(attachmentName("C:\\shots\\before.png")).toBe("before.png");
    expect(attachmentName("a\u0000b.png")).toBe("ab.png");
    expect(attachmentName("///")).toBe("");
  });

  it("refuses by naming the file and the reason", () => {
    const refusal = (inputs: Parameters<typeof admitSignalAttachments>[0]) => {
      const result = admitSignalAttachments(inputs);
      return result.ok ? undefined : result.refusal;
    };
    expect(refusal([file("build.zip", Buffer.from("PK"))])).toMatchObject({ path: "attach[0]" });
    expect(refusal([file("build.zip", Buffer.from("PK"))])?.message).toContain("build.zip: only images");
    expect(refusal([file("a.png", PNG), file("fake.png", Buffer.from("text"))])).toMatchObject({ path: "attach[1]" });
    expect(refusal([{ name: "a.png", bytesBase64: "not base64!" }])?.message).toContain("Base64");
    expect(refusal([file("", PNG)])?.message).toContain("file name");
    expect(refusal([file("a.png", PNG, "x".repeat(121))])?.message).toContain("caption");
    expect(refusal(Array.from({ length: 13 }, (_, n) => file(`${n}.png`, PNG)))).toMatchObject({ path: "attach" });
    const big = Buffer.concat([PNG, Buffer.alloc(AGENT_SIGNAL_MAX_ATTACHMENT_BYTES / 2)]);
    expect(refusal([file("a.png", big), file("b.png", big)])).toMatchObject({ path: "attach[1]" });
  });

  it("holds a signal's files under the signal in the content store", () => {
    expect(signalAttachmentOwner({ signalId: "s1", canvasName: "factory", nodeId: "atlas" })).toEqual({
      kind: "other",
      canvasName: "factory",
      nodeId: "atlas",
      recordId: "signal:s1",
    });
  });
});
