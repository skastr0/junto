import { describe, expect, it } from "vitest";
import { schemeDsrFor } from "@shared/theme";
import { attachXtermAppearance } from "../src/renderer/lib/xterm-appearance";
import type { Terminal } from "@xterm/xterm";

/**
 * Minimal Terminal stub for CSI handler registration + input replies.
 * xterm's real parser is not required to prove the appearance protocol.
 */
const makeTermStub = () => {
  const csi: Array<{
    id: { prefix?: string; intermediates?: string; final: string };
    cb: (params: (number | number[])[]) => boolean | Promise<boolean>;
  }> = [];
  let theme: unknown;
  const inputs: string[] = [];

  const term = {
    options: {
      get theme() {
        return theme;
      },
      set theme(v: unknown) {
        theme = v;
      },
    },
    input: (data: string, _wasUser?: boolean) => {
      inputs.push(data);
    },
    parser: {
      registerCsiHandler: (
        id: { prefix?: string; intermediates?: string; final: string },
        cb: (params: (number | number[])[]) => boolean | Promise<boolean>,
      ) => {
        csi.push({ id, cb });
        return { dispose: () => undefined };
      },
    },
  } as unknown as Terminal;

  return {
    term,
    csi,
    inputs,
    getTheme: () => theme,
  };
};

const findHandler = (
  csi: ReturnType<typeof makeTermStub>["csi"],
  match: { prefix?: string; intermediates?: string; final: string },
) =>
  csi.find(
    (h) =>
      h.id.final === match.final &&
      h.id.prefix === match.prefix &&
      h.id.intermediates === match.intermediates,
  );

describe("attachXtermAppearance", () => {
  it("answers CSI ?996n with the active scheme DSR", () => {
    const stub = makeTermStub();
    const handle = attachXtermAppearance(stub.term, { initialMode: "dark" });
    const n = findHandler(stub.csi, { prefix: "?", final: "n" });
    expect(n).toBeDefined();
    expect(n!.cb([996])).toBe(true);
    expect(stub.inputs).toEqual([schemeDsrFor("dark")]);
    handle.dispose();
  });

  it("enables ?2031 subscription and emits an immediate DSR", () => {
    const stub = makeTermStub();
    const handle = attachXtermAppearance(stub.term, { initialMode: "bright" });
    const h = findHandler(stub.csi, { prefix: "?", final: "h" });
    expect(h!.cb([2031])).toBe(false); // co-packed modes must still reach xterm
    expect(handle.isSubscribed()).toBe(true);
    expect(stub.inputs).toEqual([schemeDsrFor("bright")]);
    handle.dispose();
  });

  it("disables subscription on ?2031l", () => {
    const stub = makeTermStub();
    const handle = attachXtermAppearance(stub.term, { initialMode: "dark" });
    findHandler(stub.csi, { prefix: "?", final: "h" })!.cb([2031]);
    findHandler(stub.csi, { prefix: "?", final: "l" })!.cb([2031]);
    expect(handle.isSubscribed()).toBe(false);
    handle.dispose();
  });

  it("reports DECRQM for mode 2031", () => {
    const stub = makeTermStub();
    const handle = attachXtermAppearance(stub.term, { initialMode: "dark" });
    const p = findHandler(stub.csi, {
      prefix: "?",
      intermediates: "$",
      final: "p",
    });
    expect(p!.cb([2031])).toBe(true);
    expect(stub.inputs.at(-1)).toBe("\x1b[?2031;2$y"); // reset
    findHandler(stub.csi, { prefix: "?", final: "h" })!.cb([2031]);
    stub.inputs.length = 0;
    expect(p!.cb([2031])).toBe(true);
    expect(stub.inputs.at(-1)).toBe("\x1b[?2031;1$y"); // set
    handle.dispose();
  });

  it("emits live ?997 on mode change when subscribed (follow policy)", () => {
    const stub = makeTermStub();
    const handle = attachXtermAppearance(stub.term, {
      initialMode: "dark",
      policy: "follow",
    });
    findHandler(stub.csi, { prefix: "?", final: "h" })!.cb([2031]);
    stub.inputs.length = 0;
    handle.setMode("bright");
    expect(stub.inputs).toEqual([schemeDsrFor("bright")]);
    expect(stub.getTheme()).toBeDefined();
    handle.dispose();
  });

  it("agent policy does not re-apply theme on mode change", () => {
    const stub = makeTermStub();
    const handle = attachXtermAppearance(stub.term, {
      initialMode: "dark",
      policy: "agent",
    });
    handle.setMode("bright");
    expect(stub.getTheme()).toBeUndefined();
    // Queries still answer.
    findHandler(stub.csi, { prefix: "?", final: "n" })!.cb([996]);
    expect(stub.inputs.at(-1)).toBe(schemeDsrFor("bright"));
    handle.dispose();
  });

  it("ignores unrelated CSI n params", () => {
    const stub = makeTermStub();
    const handle = attachXtermAppearance(stub.term, { initialMode: "dark" });
    expect(findHandler(stub.csi, { prefix: "?", final: "n" })!.cb([6])).toBe(
      false,
    );
    expect(stub.inputs).toEqual([]);
    handle.dispose();
  });
});
