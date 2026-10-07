/** Host launch qualification only. Stub binaries do not qualify vendor tools. */
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { Result } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HARNESS_IDS, templateFor } from "../src/shared/managed-terminal-templates";
import { resolveLaunch } from "../src/main/junto/term/local-host";
import { installHermeticHarnessBins } from "./helpers/hermetic-harness-bins";

const HOST_MARKER = "synthetic-host-generation";
let restoreBins: () => void;

beforeEach(() => {
  restoreBins = installHermeticHarnessBins();
  vi.stubEnv("JUNTO_WORK_TOKEN", "synthetic-ambient-generation");
});
afterEach(() => {
  vi.unstubAllEnvs();
  restoreBins();
});

describe("seat credential host environment", () => {
  it.each(HARNESS_IDS)("%s: host credential wins without entering argv", (harness) => {
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
