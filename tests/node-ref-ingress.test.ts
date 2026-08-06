import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { nodeRefKey, type NodeRef } from "../src/shared/node-ref";
import {
  canonicalNodeRefUri,
  latestNodeRefUri,
  makeNodeRefIngress,
  type NodeRefIngressTarget,
} from "../src/main/vellum/node-ref-ingress";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const ref = (canvasName: string, nodeId: string): NodeRef => ({ canvasName, nodeId });

describe("node-reference ingress", () => {
  it("rejects invalid and noncanonical input before invoking the resolver", async () => {
    const resolve = vi.fn(async (value: NodeRef) => ({ key: nodeRefKey(value) }));
    const ingress = makeNodeRefIngress(resolve);

    await expect(ingress.accept("https://example.com/")).resolves.toMatchObject({
      ok: false,
      code: "invalid",
    });
    await expect(
      ingress.accept("vellum-command://canvas/portfolio?node=%70age"),
    ).resolves.toMatchObject({
      ok: false,
      code: "invalid",
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("emits only a canonical minimal target after exact resolution", async () => {
    const value = ref("portfolio", "page/a");
    const emitted: NodeRefIngressTarget[] = [];
    const ingress = makeNodeRefIngress(async (candidate) => ({ key: nodeRefKey(candidate) }));
    ingress.connect((target) => emitted.push(target));

    const result = await ingress.accept(nodeRefKey(value));

    expect(result).toEqual({
      ok: true,
      delivery: "emitted",
      target: {
        ref: "vellum-command://canvas/portfolio?node=page%2Fa",
        canvasName: "portfolio",
        nodeId: "page/a",
      },
    });
    expect(emitted).toEqual([result.ok ? result.target : undefined]);
    expect(Object.keys(emitted[0] ?? {}).sort()).toEqual(["canvasName", "nodeId", "ref"]);
  });

  it("keeps exactly the latest resolved target while no owner sink is connected", async () => {
    const ingress = makeNodeRefIngress(async (candidate) => ({ key: nodeRefKey(candidate) }));
    await ingress.accept(nodeRefKey(ref("portfolio", "first")));
    await ingress.accept(nodeRefKey(ref("portfolio", "second")));
    await ingress.accept(nodeRefKey(ref("portfolio", "third")));
    const emitted: NodeRefIngressTarget[] = [];

    const disconnect = ingress.connect((target) => emitted.push(target));
    disconnect();

    expect(emitted.map((target) => target.nodeId)).toEqual(["third"]);
  });

  it("prevents a slow older resolution from emitting after a newer locator", async () => {
    const first = deferred<{ readonly key: string }>();
    const ingress = makeNodeRefIngress((candidate) =>
      candidate.nodeId === "first"
        ? first.promise
        : Promise.resolve({ key: nodeRefKey(candidate) }),
    );
    const emitted: NodeRefIngressTarget[] = [];
    ingress.connect((target) => emitted.push(target));

    const older = ingress.accept(nodeRefKey(ref("portfolio", "first")));
    const newer = ingress.accept(nodeRefKey(ref("portfolio", "second")));
    await expect(newer).resolves.toMatchObject({ ok: true });
    first.resolve({ key: nodeRefKey(ref("portfolio", "first")) });
    await expect(older).resolves.toMatchObject({ ok: false, code: "superseded" });

    expect(emitted.map((target) => target.nodeId)).toEqual(["second"]);
  });

  it("invalidates an older pending resolution even when the newer input is invalid", async () => {
    const first = deferred<{ readonly key: string }>();
    const ingress = makeNodeRefIngress(() => first.promise);
    const older = ingress.accept(nodeRefKey(ref("portfolio", "first")));

    await expect(ingress.accept("vellum-command://canvas/portfolio?node=%ZZ")).resolves.toMatchObject({
      ok: false,
      code: "invalid",
    });
    first.resolve({ key: nodeRefKey(ref("portfolio", "first")) });

    await expect(older).resolves.toMatchObject({ ok: false, code: "superseded" });
  });

  it("fails closed on resolver errors and canonical-key substitution", async () => {
    const unavailable = makeNodeRefIngress(async () => {
      throw new Error("canvas unavailable");
    });
    await expect(
      unavailable.accept(nodeRefKey(ref("portfolio", "page"))),
    ).resolves.toMatchObject({ ok: false, code: "unresolved", message: "canvas unavailable" });

    const substituted = makeNodeRefIngress(async () => ({
      key: nodeRefKey(ref("other", "page")),
    }));
    await expect(
      substituted.accept(nodeRefKey(ref("portfolio", "page"))),
    ).resolves.toMatchObject({ ok: false, code: "unresolved" });
  });

  it("retains a queued target when a sink throws and retries on the next sink", async () => {
    const ingress = makeNodeRefIngress(async (candidate) => ({ key: nodeRefKey(candidate) }));
    ingress.connect(() => {
      throw new Error("renderer unavailable");
    });

    await expect(
      ingress.accept(nodeRefKey(ref("portfolio", "page"))),
    ).resolves.toMatchObject({ ok: true, delivery: "queued" });
    const emitted: NodeRefIngressTarget[] = [];
    ingress.connect((target) => emitted.push(target));

    expect(emitted.map((target) => target.nodeId)).toEqual(["page"]);
  });
});

describe("owner-memory open-url selection", () => {
  it("accepts exact canonical syntax and selects the latest command-line target", () => {
    const first = nodeRefKey(ref("portfolio", "first"));
    const second = nodeRefKey(ref("portfolio", "second"));

    expect(canonicalNodeRefUri(first)).toBe(first);
    expect(canonicalNodeRefUri("vellum-command://canvas/portfolio?node=%73econd")).toBeUndefined();
    expect(latestNodeRefUri(["vellum", first, "--flag", second])).toBe(second);
    expect(latestNodeRefUri(["vellum", "https://example.com/"])).toBeUndefined();
  });

  it("has no filesystem relay exports, paths, artifacts, or watcher", async () => {
    const module = await import("../src/main/vellum/node-ref-ingress");
    const [ingressSource, indexSource] = await Promise.all([
      readFile(
        new URL("../src/main/vellum/node-ref-ingress.ts", import.meta.url),
        "utf8",
      ),
      readFile(new URL("../src/main/index.ts", import.meta.url), "utf8"),
    ]);
    const productSource = `${ingressSource}\n${indexSource}`;
    const retiredExports = [
      ["publishNodeRef", "Relay"].join(""),
      ["claimLatestNodeRef", "Relay"].join(""),
      ["acknowledgeNodeRef", "Relay"].join(""),
      ["publishNodeRef", "OpenUrl"].join(""),
    ];
    for (const name of retiredExports) {
      expect(name in module).toBe(false);
      expect(productSource).not.toContain(name);
    }
    for (const signature of [
      ["NodeRef", "RelayRecord"].join(""),
      ["nodeRef", "RelayWatcher"].join(""),
      ['"runtime", "', "open-url", '"'].join(""),
      ["pending", "-${"].join(""),
      ["processing", "-${"].join(""),
      [".temporary", "-"].join(""),
      ["acknowledging", "-"].join(""),
    ]) {
      expect(productSource).not.toContain(signature);
    }
    expect(ingressSource).not.toContain(["node:", "fs"].join(""));
    expect(indexSource).toMatch(
      /app\.on\("open-url",[\s\S]*event\.preventDefault\(\);[\s\S]*queueNodeRefUri\(uri\)/u,
    );
    expect(indexSource).toMatch(
      /app\.on\("second-instance",[\s\S]*latestNodeRefUri\(commandLine\)[\s\S]*queueNodeRefUri\(uri\)/u,
    );
  });
});
