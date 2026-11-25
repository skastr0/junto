/** Host launch qualification only. Stub binaries do not qualify vendor tools. */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Result } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HARNESS_IDS, templateFor } from "../src/shared/managed-terminal-templates";
import { resolveLaunch } from "../src/core/term/local-host";
import { nodeHostEntry } from "../src/core/term/templates/node-host";
import { installHermeticHarnessBins } from "./helpers/hermetic-harness-bins";

const HOST_MARKER = "synthetic-host-generation";
// A node host seat (the live overseer) runs on Junto's Node, whose own
// variables must never replace the seat's credential.
vi.mock("../src/core/automation/code-runner", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/core/automation/code-runner")>(),
  machineNodeRuntime: () => ({
    command: process.execPath,
    env: { ELECTRON_RUN_AS_NODE: "1", JUNTO_WORK_TOKEN: "synthetic-runtime-generation" },
  }),
}));
let restoreBins: () => void;
let build: string;

beforeEach(() => {
  restoreBins = installHermeticHarnessBins();
  vi.stubEnv("JUNTO_WORK_TOKEN", "synthetic-ambient-generation");
  build = mkdtempSync(join(tmpdir(), "junto-credential-build-"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  restoreBins();
  rmSync(build, { recursive: true, force: true });
});

describe("seat credential host environment", () => {
  it.each(HARNESS_IDS)("%s: host credential wins without entering argv", (harness) => {
    const { binary, nodeHost } = templateFor(harness).argvSpec;
    if (nodeHost) {
      // This build's entry, in the working folder a node host is read from.
      mkdirSync(join(build, "out", "main"), { recursive: true });
      writeFileSync(nodeHostEntry(binary, build), "");
      vi.spyOn(process, "cwd").mockReturnValue(build);
    }
    const launch = Result.getOrThrow(resolveLaunch({
      kind: "agent", harness, agentKey: `local:${harness}`,
      launch: {
        kind: "harness", argv: [templateFor(harness).argvSpec.binary], cwd: tmpdir(),
        env: { JUNTO_WORK_TOKEN: "synthetic-document-generation" },
      },
    }, {
      regionEnv: { JUNTO_WORK_TOKEN: "synthetic-region-generation" },
      seatInject: { JUNTO_WORK_TOKEN: HOST_MARKER },
    }));
    expect(launch.env.JUNTO_WORK_TOKEN).toBe(HOST_MARKER);
    expect(launch.args.join(" ")).not.toContain(HOST_MARKER);
    if (nodeHost) {
      expect(launch.file).toBe(process.execPath);
      expect(launch.args[0]).toBe(nodeHostEntry(binary, build));
      expect(launch.env.ELECTRON_RUN_AS_NODE).toBe("1");
    }
  });

  it("nested POSIX shells retain the value without caller-supplied arguments", async () => {
    const { stdout } = await promisify(execFile)("/bin/sh", [
      "-c", 'exec /bin/sh -c \'test "$JUNTO_WORK_TOKEN" = "synthetic-host-generation" && printf retained\'',
    ], {
      env: { PATH: "/usr/bin:/bin", JUNTO_WORK_TOKEN: HOST_MARKER },
      timeout: 5_000,
    });
    expect(stdout).toBe("retained");
  });
});
