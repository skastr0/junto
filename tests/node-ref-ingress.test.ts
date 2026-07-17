import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nodeRefKey, type NodeRef } from "../src/shared/node-ref";
import {
  NODE_REF_RELAY_FUTURE_TOLERANCE_MS,
  NODE_REF_RELAY_MAX_BYTES,
  NODE_REF_RELAY_MAX_RECORDS,
  NODE_REF_RELAY_TTL_MS,
  acknowledgeNodeRefRelay,
  claimLatestNodeRefRelay,
  makeNodeRefIngress,
  publishNodeRefOpenUrl,
  publishNodeRefRelay,
  type NodeRefIngressTarget,
  type NodeRefRelayPublishResult,
  type NodeRefRelayRecord,
} from "../src/main/vellum/node-ref-ingress";

const TEST_ROOT_PREFIX = "/tmp/vnr-";
const roots: string[] = [];

const newRoot = async (): Promise<string> => {
  const root = await mkdtemp(TEST_ROOT_PREFIX);
  roots.push(root);
  return root;
};

const mode = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

const relayDirectory = (root: string): string => join(root, "runtime", "open-url");

const relayRecordPath = (
  directory: string,
  state: "pending" | "processing",
  id: string,
): string => join(directory, `${state}-${id}.json`);

const published = (
  result: NodeRefRelayPublishResult,
): Extract<NodeRefRelayPublishResult, { readonly kind: "published" }> => {
  expect(result.kind).toBe("published");
  if (result.kind !== "published") throw new Error(`expected published, got ${result.code}`);
  return result;
};

const TEST_IDS = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
  "00000000-0000-4000-8000-000000000004",
] as const;

const prepareRelayDirectory = async (directory: string): Promise<void> => {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(join(directory, ".."), 0o700);
  await chmod(directory, 0o700);
};

const writeRelayRecord = async (
  directory: string,
  state: "pending" | "processing",
  record: NodeRefRelayRecord,
  options: {
    readonly fileMode?: number;
    readonly mtime?: number;
    readonly bytes?: Buffer;
  } = {},
): Promise<string> => {
  await prepareRelayDirectory(directory);
  const path = relayRecordPath(directory, state, record.id);
  const bytes = options.bytes ?? Buffer.from(JSON.stringify(record), "utf8");
  await writeFile(path, bytes, { mode: options.fileMode ?? 0o600 });
  await chmod(path, options.fileMode ?? 0o600);
  const mtime = options.mtime ?? record.receivedAt;
  await utimes(path, mtime / 1_000, mtime / 1_000);
  return path;
};

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

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    if (!root.startsWith(TEST_ROOT_PREFIX)) {
      throw new Error(`refusing unsafe node-ref test cleanup: ${root}`);
    }
    await rm(root, { recursive: true, force: true });
  }
});

describe("node-reference ingress", () => {
  it("rejects invalid input before invoking the resolver", async () => {
    const resolve = vi.fn(async (value: NodeRef) => ({ key: nodeRefKey(value) }));
    const ingress = makeNodeRefIngress(resolve);

    await expect(ingress.accept("https://example.com/")).resolves.toMatchObject({
      ok: false,
      code: "invalid",
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(ingress.hasAcceptedInput()).toBe(true);
    expect(ingress.pendingTarget()).toBeUndefined();
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
        ref: "vellum://canvas/portfolio?node=page%2Fa",
        canvasName: "portfolio",
        nodeId: "page/a",
      },
    });
    expect(emitted).toEqual([result.ok ? result.target : undefined]);
    expect(Object.keys(emitted[0] ?? {}).sort()).toEqual(["canvasName", "nodeId", "ref"]);
  });

  it("queues exactly the latest resolved target until a sink connects", async () => {
    const ingress = makeNodeRefIngress(async (candidate) => ({ key: nodeRefKey(candidate) }));
    await ingress.accept(nodeRefKey(ref("portfolio", "first")));
    await ingress.accept(nodeRefKey(ref("portfolio", "second")));
    const emitted: NodeRefIngressTarget[] = [];

    const disconnect = ingress.connect((target) => emitted.push(target));
    disconnect();

    expect(emitted.map((target) => target.nodeId)).toEqual(["second"]);
    expect(ingress.pendingTarget()).toBeUndefined();
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
    await ingress.waitForIdle();

    expect(emitted.map((target) => target.nodeId)).toEqual(["second"]);
  });

  it("invalidates an older pending resolution even when the newer input is invalid", async () => {
    const first = deferred<{ readonly key: string }>();
    const ingress = makeNodeRefIngress(() => first.promise);
    const older = ingress.accept(nodeRefKey(ref("portfolio", "first")));

    await expect(ingress.accept("vellum://canvas/portfolio?node=%ZZ")).resolves.toMatchObject({
      ok: false,
      code: "invalid",
    });
    first.resolve({ key: nodeRefKey(ref("portfolio", "first")) });

    await expect(older).resolves.toMatchObject({ ok: false, code: "superseded" });
    expect(ingress.pendingTarget()).toBeUndefined();
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
    expect(substituted.pendingTarget()).toBeUndefined();
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

describe("node-reference supervision relay", () => {
  it("prevents native handling synchronously and publishes canonical syntax without resolving", async () => {
    const root = await newRoot();
    const directory = relayDirectory(root);
    const canonical = nodeRefKey(ref("portfolio", "page"));
    const event = { preventDefault: vi.fn() };

    const pending = publishNodeRefOpenUrl(event, canonical, directory, 1_000);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    const result = published(await pending);

    expect(result.uri).toBe(canonical);
    expect(await mode(join(root, "runtime"))).toBe(0o700);
    expect(await mode(directory)).toBe(0o700);
    expect(await mode(relayRecordPath(directory, "pending", result.id))).toBe(0o600);
    const stored = JSON.parse(
      await readFile(relayRecordPath(directory, "pending", result.id), "utf8"),
    ) as unknown;
    expect(stored).toEqual({
      version: 1,
      id: result.id,
      receivedAt: 1_000,
      uri: canonical,
    });
  });

  it("does not clobber concurrent publications or expose a partially staged record", async () => {
    const root = await newRoot();
    const directory = relayDirectory(root);
    const [leftResult, rightResult] = await Promise.all([
      publishNodeRefRelay(directory, nodeRefKey(ref("portfolio", "left")), 1_000),
      publishNodeRefRelay(directory, nodeRefKey(ref("portfolio", "right")), 1_000),
    ]);
    const left = published(leftResult);
    const right = published(rightResult);

    expect(left.id).not.toBe(right.id);
    expect((await readdir(directory)).sort()).toEqual(
      [`pending-${left.id}.json`, `pending-${right.id}.json`].sort(),
    );

    const stagingRoot = await newRoot();
    const stagingDirectory = relayDirectory(stagingRoot);
    await prepareRelayDirectory(stagingDirectory);
    const temporary = join(stagingDirectory, `.temporary-${TEST_IDS[0]}.json`);
    await writeFile(temporary, "{partial", { mode: 0o600 });
    await chmod(temporary, 0o600);
    await utimes(temporary, 1, 1);

    await expect(claimLatestNodeRefRelay(stagingDirectory, 1_001)).resolves.toBeUndefined();
    expect(await readFile(temporary, "utf8")).toBe("{partial");

    const record: NodeRefRelayRecord = {
      version: 1,
      id: TEST_IDS[0],
      receivedAt: 1_000,
      uri: nodeRefKey(ref("portfolio", "staged")),
    };
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
    await chmod(temporary, 0o600);
    await utimes(temporary, 1, 1);
    await rename(temporary, relayRecordPath(stagingDirectory, "pending", record.id));
    await expect(claimLatestNodeRefRelay(stagingDirectory, 1_001)).resolves.toEqual(record);
  });

  it("rejects invalid, noncanonical, control-bearing, and oversized syntax without mutation", async () => {
    const root = await newRoot();
    const directory = relayDirectory(root);
    const valid = published(
      await publishNodeRefRelay(directory, nodeRefKey(ref("portfolio", "older")), 1_000),
    );
    const before = await readdir(directory);
    const invalid = [
      "https://example.com/",
      "vellum://canvas/portfolio?node=%6Flder",
      "vellum://canvas/portfolio?node=line%0Abreak",
      `vellum://canvas/portfolio?node=${"x".repeat(4_097)}`,
    ];

    for (const uri of invalid) {
      await expect(publishNodeRefRelay(directory, uri, 2_000)).resolves.toMatchObject({
        kind: "invalid",
      });
    }

    expect(await readdir(directory)).toEqual(before);
    await expect(claimLatestNodeRefRelay(directory, 2_000)).resolves.toMatchObject({
      id: valid.id,
    });
  });

  it("uses unique atomic records and deterministically selects receivedAt, mtime, then id", async () => {
    const cases = [
      {
        left: { receivedAt: 2_001, mtime: 2_000, id: TEST_IDS[0] },
        right: { receivedAt: 2_000, mtime: 3_000, id: TEST_IDS[1] },
        expected: TEST_IDS[0],
      },
      {
        left: { receivedAt: 2_000, mtime: 2_001, id: TEST_IDS[0] },
        right: { receivedAt: 2_000, mtime: 2_002, id: TEST_IDS[1] },
        expected: TEST_IDS[1],
      },
      {
        left: { receivedAt: 2_000, mtime: 2_000, id: TEST_IDS[0] },
        right: { receivedAt: 2_000, mtime: 2_000, id: TEST_IDS[1] },
        expected: TEST_IDS[1],
      },
    ];

    for (const testCase of cases) {
      const root = await newRoot();
      const directory = relayDirectory(root);
      for (const candidate of [testCase.left, testCase.right]) {
        await writeRelayRecord(
          directory,
          "pending",
          {
            version: 1,
            id: candidate.id,
            receivedAt: candidate.receivedAt,
            uri: nodeRefKey(ref("portfolio", candidate.id)),
          },
          { mtime: candidate.mtime },
        );
      }

      await expect(claimLatestNodeRefRelay(directory, 3_001)).resolves.toMatchObject({
        id: testCase.expected,
      });
      const names = await readdir(directory);
      expect(names).toEqual([`processing-${testCase.expected}.json`]);
    }
  });

  it("recovers processing claims and exact acknowledgement never deletes a newer record", async () => {
    const root = await newRoot();
    const directory = relayDirectory(root);
    const first = published(
      await publishNodeRefRelay(directory, nodeRefKey(ref("portfolio", "first")), 1_000),
    );
    await expect(claimLatestNodeRefRelay(directory, 1_001)).resolves.toMatchObject({
      id: first.id,
    });
    await expect(claimLatestNodeRefRelay(directory, 1_002)).resolves.toMatchObject({
      id: first.id,
    });

    const second = published(
      await publishNodeRefRelay(directory, nodeRefKey(ref("portfolio", "second")), 2_000),
    );
    await expect(acknowledgeNodeRefRelay(directory, first.id)).resolves.toBe(true);
    await expect(acknowledgeNodeRefRelay(directory, first.id)).resolves.toBe(false);
    await expect(claimLatestNodeRefRelay(directory, 2_001)).resolves.toMatchObject({
      id: second.id,
    });
    await expect(acknowledgeNodeRefRelay(directory, first.id)).resolves.toBe(false);
    expect((await lstat(relayRecordPath(directory, "processing", second.id))).isFile()).toBe(true);
    await expect(acknowledgeNodeRefRelay(directory, second.id)).resolves.toBe(true);
    await expect(readdir(directory)).resolves.toEqual([]);
  });

  it("supersedes an unacknowledged retry only after a newer valid record exists", async () => {
    const root = await newRoot();
    const directory = relayDirectory(root);
    const first = published(
      await publishNodeRefRelay(directory, nodeRefKey(ref("portfolio", "retry")), 1_000),
    );
    await claimLatestNodeRefRelay(directory, 1_001);
    const invalidId = TEST_IDS[3];
    await writeRelayRecord(
      directory,
      "pending",
      {
        version: 1,
        id: invalidId,
        receivedAt: 2_000,
        uri: "vellum://canvas/portfolio?node=%72etry",
      },
    );

    await expect(claimLatestNodeRefRelay(directory, 2_001)).resolves.toMatchObject({
      id: first.id,
    });

    const second = published(
      await publishNodeRefRelay(directory, nodeRefKey(ref("portfolio", "newer")), 3_000),
    );
    await expect(claimLatestNodeRefRelay(directory, 3_001)).resolves.toMatchObject({
      id: second.id,
    });
    expect(await readdir(directory)).toEqual([`processing-${second.id}.json`]);
  });

  it("accepts exact TTL/future/size bounds and rejects one unit beyond each", async () => {
    const canonical = nodeRefKey(ref("portfolio", "bounded"));

    const ttlRoot = await newRoot();
    const ttlDirectory = relayDirectory(ttlRoot);
    const ttl = published(await publishNodeRefRelay(ttlDirectory, canonical, 1_000));
    await expect(
      claimLatestNodeRefRelay(ttlDirectory, 1_000 + NODE_REF_RELAY_TTL_MS),
    ).resolves.toMatchObject({ id: ttl.id });

    const expiredRoot = await newRoot();
    const expiredDirectory = relayDirectory(expiredRoot);
    await publishNodeRefRelay(expiredDirectory, canonical, 1_000);
    await expect(
      claimLatestNodeRefRelay(expiredDirectory, 1_000 + NODE_REF_RELAY_TTL_MS + 1),
    ).resolves.toBeUndefined();

    const expiredMtimeRoot = await newRoot();
    const expiredMtimeDirectory = relayDirectory(expiredMtimeRoot);
    await writeRelayRecord(
      expiredMtimeDirectory,
      "pending",
      {
        version: 1,
        id: TEST_IDS[0],
        receivedAt: 1_000 + NODE_REF_RELAY_TTL_MS + 1,
        uri: canonical,
      },
      { mtime: 1_000 },
    );
    await expect(
      claimLatestNodeRefRelay(expiredMtimeDirectory, 1_000 + NODE_REF_RELAY_TTL_MS + 1),
    ).resolves.toBeUndefined();

    const futureRoot = await newRoot();
    const futureDirectory = relayDirectory(futureRoot);
    await writeRelayRecord(
      futureDirectory,
      "pending",
      { version: 1, id: TEST_IDS[0], receivedAt: 6_000, uri: canonical },
      { mtime: 6_000 },
    );
    await expect(
      claimLatestNodeRefRelay(futureDirectory, 6_000 - NODE_REF_RELAY_FUTURE_TOLERANCE_MS),
    ).resolves.toMatchObject({ id: TEST_IDS[0] });

    const tooFutureRoot = await newRoot();
    const tooFutureDirectory = relayDirectory(tooFutureRoot);
    await writeRelayRecord(
      tooFutureDirectory,
      "pending",
      { version: 1, id: TEST_IDS[0], receivedAt: 6_001, uri: canonical },
      { mtime: 6_001 },
    );
    await expect(claimLatestNodeRefRelay(tooFutureDirectory, 1_000)).resolves.toBeUndefined();

    const futureMtimeRoot = await newRoot();
    const futureMtimeDirectory = relayDirectory(futureMtimeRoot);
    await writeRelayRecord(
      futureMtimeDirectory,
      "pending",
      { version: 1, id: TEST_IDS[0], receivedAt: 1_000, uri: canonical },
      { mtime: 1_000 + NODE_REF_RELAY_FUTURE_TOLERANCE_MS + 1 },
    );
    await expect(claimLatestNodeRefRelay(futureMtimeDirectory, 1_000)).resolves.toBeUndefined();

    const exactSizeRoot = await newRoot();
    const exactSizeDirectory = relayDirectory(exactSizeRoot);
    const exactRecord: NodeRefRelayRecord = {
      version: 1,
      id: TEST_IDS[0],
      receivedAt: 1_000,
      uri: canonical,
    };
    const encoded = Buffer.from(JSON.stringify(exactRecord), "utf8");
    const exactBytes = Buffer.concat([
      encoded,
      Buffer.alloc(NODE_REF_RELAY_MAX_BYTES - encoded.byteLength, 0x20),
    ]);
    await writeRelayRecord(exactSizeDirectory, "pending", exactRecord, { bytes: exactBytes });
    await expect(claimLatestNodeRefRelay(exactSizeDirectory, 1_001)).resolves.toMatchObject({
      id: TEST_IDS[0],
    });

    const oversizedRoot = await newRoot();
    const oversizedDirectory = relayDirectory(oversizedRoot);
    await writeRelayRecord(oversizedDirectory, "pending", exactRecord, {
      bytes: Buffer.alloc(NODE_REF_RELAY_MAX_BYTES + 1, 0x20),
    });
    await expect(claimLatestNodeRefRelay(oversizedDirectory, 1_001)).resolves.toBeUndefined();
  });

  it("fails closed on symlink, wrong-mode, hard-link, and directory-substitution records", async () => {
    const canonical = nodeRefKey(ref("portfolio", "fallback"));

    const root = await newRoot();
    const directory = relayDirectory(root);
    await writeRelayRecord(directory, "pending", {
      version: 1,
      id: TEST_IDS[0],
      receivedAt: 1_000,
      uri: canonical,
    });
    const external = join(root, "external.json");
    await writeFile(external, "external");
    await symlink(external, relayRecordPath(directory, "pending", TEST_IDS[1]));
    await writeRelayRecord(
      directory,
      "pending",
      { version: 1, id: TEST_IDS[2], receivedAt: 3_000, uri: canonical },
      { fileMode: 0o644 },
    );
    const hardLinked = await writeRelayRecord(directory, "pending", {
      version: 1,
      id: TEST_IDS[3],
      receivedAt: 4_000,
      uri: canonical,
    });
    const externalHardLink = join(root, "external-hard-link.json");
    await link(hardLinked, externalHardLink);

    await expect(claimLatestNodeRefRelay(directory, 4_001)).resolves.toMatchObject({
      id: TEST_IDS[0],
    });
    await expect(readFile(external, "utf8")).resolves.toBe("external");
    await expect(readFile(externalHardLink, "utf8")).resolves.toContain(canonical);

    const substitutionRoot = await newRoot();
    const substitutionDirectory = relayDirectory(substitutionRoot);
    await prepareRelayDirectory(substitutionDirectory);
    await mkdir(relayRecordPath(substitutionDirectory, "pending", TEST_IDS[0]));
    await expect(claimLatestNodeRefRelay(substitutionDirectory, 1_000)).rejects.toThrow();
  });

  it("rejects insecure or symlinked managed directories without chmodding their targets", async () => {
    const root = await newRoot();
    const runtime = join(root, "runtime");
    const external = join(root, "external-runtime");
    await mkdir(external, { mode: 0o755 });
    await chmod(external, 0o755);
    await symlink(external, runtime);

    await expect(
      publishNodeRefRelay(
        join(runtime, "open-url"),
        nodeRefKey(ref("portfolio", "page")),
        1_000,
      ),
    ).rejects.toThrow("current-user real directory");
    expect(await mode(external)).toBe(0o755);

    const wrongModeRoot = await newRoot();
    const wrongModeRuntime = join(wrongModeRoot, "runtime");
    await mkdir(wrongModeRuntime, { mode: 0o755 });
    await chmod(wrongModeRuntime, 0o755);
    await expect(
      publishNodeRefRelay(
        join(wrongModeRuntime, "open-url"),
        nodeRefKey(ref("portfolio", "page")),
        1_000,
      ),
    ).rejects.toThrow("permissions are insecure");
    expect(await mode(wrongModeRuntime)).toBe(0o755);
  });

  it("validates current uid and bounds recoverable artifacts while yielding cleanup work", async () => {
    const root = await newRoot();
    const directory = relayDirectory(root);
    for (let index = 0; index < NODE_REF_RELAY_MAX_RECORDS + 3; index += 1) {
      await publishNodeRefRelay(
        directory,
        nodeRefKey(ref("portfolio", `page-${index}`)),
        1_000 + index,
      );
    }
    expect((await readdir(directory)).filter((name) => !name.startsWith("."))).toHaveLength(
      NODE_REF_RELAY_MAX_RECORDS,
    );

    for (let index = 0; index < 17; index += 1) {
      const id = `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      await writeFile(relayRecordPath(directory, "pending", id), "not-json", { mode: 0o600 });
      await chmod(relayRecordPath(directory, "pending", id), 0o600);
    }
    let yielded = false;
    setImmediate(() => {
      yielded = true;
    });
    await claimLatestNodeRefRelay(directory, 2_000);
    expect(yielded).toBe(true);
    expect((await readdir(directory)).filter((name) => name.startsWith("processing-"))).toHaveLength(
      1,
    );

    const uid = process.getuid?.();
    if (uid !== undefined) {
      vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
      await expect(claimLatestNodeRefRelay(directory, 2_000)).rejects.toThrow(
        "current-user real directory",
      );
    }
  });
});
