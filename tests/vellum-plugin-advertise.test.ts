import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ADVERTISED_TOOL_NAMES,
  isWorkSocketReachable,
  listAdvertisedTools,
  WORK_HOME_ENV,
  WORK_SOCKET_ENV,
} from "../packages/vellum-plugin/tools/shared/work-client";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("vellum-plugin tool advertise (offline empty)", () => {
  it("lists the seven opt-in tools when socket path exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "vellum-plugin-sock-"));
    tempRoots.push(root);
    const sock = join(root, "control.sock");
    // Placeholder file — reachability is path-present, not a live accept.
    await writeFile(sock, "");
    const env = {
      [WORK_HOME_ENV]: root,
      [WORK_SOCKET_ENV]: sock,
    };
    expect(isWorkSocketReachable(env)).toBe(true);
    expect(listAdvertisedTools(env)).toEqual([...ADVERTISED_TOOL_NAMES]);
    expect(listAdvertisedTools(env)).toHaveLength(7);
  });

  it("advertises empty tool list when no station socket is reachable", () => {
    const env = {
      [WORK_HOME_ENV]: "/no/such/vellum/work/home",
      [WORK_SOCKET_ENV]: "/no/such/control.sock",
    };
    expect(isWorkSocketReachable(env)).toBe(false);
    expect(listAdvertisedTools(env)).toEqual([]);
  });

  it("does not invent tools when work home exists but socket is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "vellum-plugin-nosock-"));
    tempRoots.push(root);
    await writeFile(join(root, "token"), "tok\n");
    const env = { [WORK_HOME_ENV]: root };
    expect(isWorkSocketReachable(env)).toBe(false);
    expect(listAdvertisedTools(env)).toEqual([]);
  });
});
