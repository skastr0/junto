// @vitest-environment jsdom
/**
 * The operator's attachment tray, one for every composer: a file added by
 * pick, paste or drop uploads at once in pieces as the operator, shows as a
 * chip (an image as its thumbnail), and the composer gets the refs only
 * once every file is in. Past the count or the size a file is refused in
 * words and never uploaded.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONTENT_STAGE_PIECE_BYTES } from "../src/shared/content-stage";
import type { OperatorContentPut, OperatorContentPutResult } from "../src/shared/operator-attachments";
import {
  setOperatorContentPutter,
  uploadOperatorFile,
  useAttachments,
  type Attachments,
} from "../src/renderer/lib/operator-attachments";
import { AttachButton, AttachmentTray } from "../src/renderer/components/attachments/AttachmentTray";
import { SignalReply } from "../src/renderer/components/signals/SignalReply";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ref = (name: string, byteLength: number, mediaType: string) => ({
  sha256: "a".repeat(64),
  byteLength,
  mediaType,
  displayName: name,
});

/** Main as a fake: one closed upload per call, or held until let go. */
const fakeMain = () => {
  const calls: OperatorContentPut[] = [];
  const held: Array<() => void> = [];
  let hold = false;
  const put = vi.fn(async (input: OperatorContentPut): Promise<OperatorContentPutResult> => {
    calls.push(input);
    if (hold) await new Promise<void>((resolve) => held.push(resolve));
    const done = input.stage.done;
    if (!done) return { ok: true, result: { stageId: `stg_${"0".repeat(32)}`, byteLength: 1 } } as OperatorContentPutResult;
    return { ok: true, result: { ref: ref(String(done.displayName), 1, String(done.mediaType)) } } as OperatorContentPutResult;
  });
  return {
    put,
    calls,
    hold: () => {
      hold = true;
    },
    release: () => {
      hold = false;
      held.splice(0).forEach((resolve) => resolve());
    },
  };
};

let host: HTMLDivElement;
let root: Root;
let latest: Attachments | undefined;

function Composer() {
  const attachments = useAttachments("factory");
  latest = attachments;
  return (
    <div data-testid="composer" {...attachments.dropTarget}>
      <AttachmentTray attachments={attachments} />
      <AttachButton attachments={attachments} />
    </div>
  );
}

beforeEach(() => {
  let n = 0;
  URL.createObjectURL = vi.fn(() => `blob:preview-${(n += 1)}`);
  URL.revokeObjectURL = vi.fn();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setOperatorContentPutter(undefined);
  latest = undefined;
});

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

const pick = async (files: File[]) => {
  const input = host.querySelector<HTMLInputElement>('[data-testid="attach-files-input"]')!;
  Object.defineProperty(input, "files", { value: files, configurable: true });
  act(() => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
};

const chips = () => [...host.querySelectorAll<HTMLElement>('[data-testid="attachment-chip"]')];

describe("uploadOperatorFile", () => {
  it("sends a large file in pieces, the first opening the upload and the last closing it", async () => {
    const main = fakeMain();
    const file = new Blob([new Uint8Array(CONTENT_STAGE_PIECE_BYTES + 10)]);
    const answer = await uploadOperatorFile(main.put, "factory", file, { name: "big.bin", mediaType: "application/octet-stream" });
    expect(answer.displayName).toBe("big.bin");
    expect(main.calls).toHaveLength(2);
    expect(main.calls[0]!.stage.stageId).toBeUndefined();
    expect(main.calls[0]!.stage.done).toBeUndefined();
    expect(main.calls[1]!.stage.stageId).toBe(`stg_${"0".repeat(32)}`);
    expect(main.calls[1]!.stage.done).toEqual({ mediaType: "application/octet-stream", displayName: "big.bin" });
    // Every piece is standard Base64 of at most one piece of bytes.
    const sizes = main.calls.map((call) => atob(String(call.stage.bytesBase64)).length);
    expect(sizes).toEqual([CONTENT_STAGE_PIECE_BYTES, 10]);
  });

  it("says main's words when a piece is refused", async () => {
    const put = vi.fn(async () => ({ ok: false, message: "A file is at most 25 MB." }) as OperatorContentPutResult);
    await expect(uploadOperatorFile(put, "factory", new Blob(["x"]), { name: "x", mediaType: "text/plain" })).rejects.toThrow(
      "A file is at most 25 MB.",
    );
  });
});

describe("the attachment tray", () => {
  it("shows an image as its thumbnail and a file as a file, and hands refs once all are in", async () => {
    const main = fakeMain();
    main.hold();
    setOperatorContentPutter(main.put);
    act(() => root.render(<Composer />));
    await pick([new File(["png"], "shot.png", { type: "image/png" }), new File(["%PDF"], "spec.pdf", { type: "application/pdf" })]);
    expect(chips().map((chip) => chip.dataset.state)).toEqual(["uploading", "uploading"]);
    expect(latest!.ready).toBeUndefined();
    expect(chips()[0]!.querySelector("img")?.getAttribute("src")).toBe("blob:preview-1");
    expect(chips()[1]!.querySelector("img")).toBeNull();
    expect(chips()[1]!.textContent).toContain("PDF");
    main.release();
    await flush();
    expect(chips().map((chip) => chip.dataset.state)).toEqual(["ready", "ready"]);
    expect(latest!.ready?.map((item) => item.displayName)).toEqual(["shot.png", "spec.pdf"]);
    expect(main.calls.map((call) => call.canvasName)).toEqual(["factory", "factory"]);
  });

  it("refuses an eleventh file and one over 25 MB, in words, without uploading them", async () => {
    const main = fakeMain();
    setOperatorContentPutter(main.put);
    act(() => root.render(<Composer />));
    const big = new File(["x"], "huge.mov", { type: "video/quicktime" });
    Object.defineProperty(big, "size", { value: 25 * 1024 * 1024 + 1 });
    await pick([big]);
    expect(chips()).toHaveLength(0);
    expect(host.textContent).toContain("huge.mov is over 25 MB.");
    await pick(Array.from({ length: 11 }, (_, index) => new File(["x"], `f${index}.txt`, { type: "text/plain" })));
    expect(chips()).toHaveLength(10);
    expect(host.textContent).toContain("A mail carries at most 10 files.");
    expect(main.calls).toHaveLength(10);
    expect(host.querySelector<HTMLButtonElement>('[data-testid="attach-files"]')!.disabled).toBe(true);
  });

  it("removes a file, lets go of its thumbnail, and an upload that ends after is dropped", async () => {
    const main = fakeMain();
    main.hold();
    setOperatorContentPutter(main.put);
    act(() => root.render(<Composer />));
    await pick([new File(["png"], "shot.png", { type: "image/png" })]);
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Remove shot.png"]')!.click());
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview-1");
    main.release();
    await flush();
    expect(chips()).toHaveLength(0);
    expect(latest!.ready).toEqual([]);
  });

  it("marks a failed upload, and the mail waits until it is removed", async () => {
    setOperatorContentPutter(async () => ({ ok: false, message: "The content store is unavailable." }));
    act(() => root.render(<Composer />));
    await pick([new File(["x"], "a.txt", { type: "text/plain" })]);
    expect(chips()[0]!.dataset.state).toBe("failed");
    expect(chips()[0]!.textContent).toContain("The content store is unavailable.");
    expect(latest!.ready).toBeUndefined();
  });

  it("attaches pasted files and dropped files", async () => {
    const main = fakeMain();
    setOperatorContentPutter(main.put);
    act(() => root.render(<Composer />));
    const composer = host.querySelector<HTMLElement>('[data-testid="composer"]')!;
    const paste = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
    paste.clipboardData = { files: [new File(["png"], "image.png", { type: "image/png" })] };
    act(() => {
      composer.dispatchEvent(paste);
    });
    expect(paste.defaultPrevented).toBe(true);
    const drop = new Event("drop", { bubbles: true, cancelable: true }) as Event & { dataTransfer: unknown };
    drop.dataTransfer = { types: ["Files"], files: [new File(["x"], "notes.md", { type: "text/markdown" })] };
    act(() => {
      composer.dispatchEvent(drop);
    });
    await flush();
    expect(latest!.ready?.map((item) => item.displayName)).toEqual(["image.png", "notes.md"]);
  });
});

describe("the signal answer box", () => {
  const renderReply = () => {
    const respond = vi.fn(async () => ({ ok: true as const }));
    const onDone = vi.fn();
    act(() =>
      root.render(
        <SignalReply
          signalId="sig-1"
          canvasName="factory"
          seatNodeId="agent-1"
          respond={respond}
          dismiss={async () => ({ ok: true as const })}
          onDone={onDone}
        />,
      ),
    );
    const button = (name: string) =>
      [...host.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.trim() === name)!;
    return { respond, onDone, button };
  };

  it("sends a file with no text as the reply, once it is in, and waits while it uploads", async () => {
    const main = fakeMain();
    main.hold();
    setOperatorContentPutter(main.put);
    const { respond, onDone, button } = renderReply();
    expect(button("Send reply").disabled).toBe(true);
    await pick([new File(["png"], "shot.png", { type: "image/png" })]);
    expect(button("Send reply").disabled).toBe(true);
    expect(button("Send quietly").disabled).toBe(true);
    expect(button("Send reply").title).toBe("Waiting for the files to attach");
    main.release();
    await flush();
    expect(button("Send reply").disabled).toBe(false);
    act(() => button("Send reply").click());
    await flush();
    expect(respond).toHaveBeenCalledWith("sig-1", "", { attachments: [ref("shot.png", 1, "image/png")] });
    expect(onDone).toHaveBeenCalled();
  });

  it("sends quietly with the files and the note", async () => {
    setOperatorContentPutter(fakeMain().put);
    const { respond, button } = renderReply();
    await pick([new File(["x"], "notes.md", { type: "text/markdown" })]);
    const field = host.querySelector<HTMLTextAreaElement>("textarea")!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(field, "  see attached  ");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => button("Send quietly").click());
    await flush();
    expect(respond).toHaveBeenCalledWith("sig-1", "see attached", {
      silent: true,
      attachments: [ref("notes.md", 1, "text/markdown")],
    });
  });

  it("sends an answer past its bound as message.md, and says so before send", async () => {
    setOperatorContentPutter(fakeMain().put);
    const { respond, button } = renderReply();
    const field = host.querySelector<HTMLTextAreaElement>("textarea")!;
    const long = "y".repeat(8001);
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(field, long);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.querySelector('[data-testid="signal-reply-long-text"]')?.textContent).toBe(
      "Over 8,000 characters, so this goes as message.md, attached",
    );
    act(() => button("Send reply").click());
    await flush();
    expect(respond).toHaveBeenCalledWith("sig-1", "", { attachments: [ref("message.md", 1, "text/markdown")] });
  });

  it("says a failed file blocks the answer until it is removed, and marks itself as the drop target", async () => {
    setOperatorContentPutter(async () => ({ ok: false, message: "The content store is unavailable." }));
    const { button } = renderReply();
    expect(host.querySelector('[data-testid="signal-reply"]')?.getAttribute("data-attach-drop")).toBe("true");
    await pick([new File(["x"], "a.txt", { type: "text/plain" })]);
    expect(button("Send reply").title).toBe("A file did not attach: remove it, or attach it again");
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Remove a.txt"]')!.click());
    await flush();
    expect(button("Send quietly").disabled).toBe(false);
  });

  it("answers as before with no files: no options on a reply, silent on a quiet one", async () => {
    setOperatorContentPutter(fakeMain().put);
    const { respond, button } = renderReply();
    act(() => button("Send quietly").click());
    await flush();
    expect(respond).toHaveBeenCalledWith("sig-1", "", { silent: true });
  });
});
