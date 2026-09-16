import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertMuxControlDirBudget,
  expandedMuxControlPathBytes,
  muxControlPathFitsUnixLimit,
  OPENSSH_CONTROL_PATH_TEMP_SUFFIX,
  sshMuxControlDir,
  sshMuxControlPathTemplate,
  UNIX_DOMAIN_SOCKET_PATH_LIMIT,
} from "../src/main/vellum-command/ssh/control-dir";
import { createSshProgramCompiler } from "../src/main/vellum-command/ssh/program";

describe("SSH mux control directory", () => {
  it("keeps the expanded ControlPath plus OpenSSH temp suffix under the Unix limit", () => {
    const dir = sshMuxControlDir(
      "/Users/developer-with-a-long-home-name/.junto-dev",
      501,
    );
    expect(dir).toMatch(/^\/tmp\/vc-501-[0-9a-f]{8}$/u);
    expect(sshMuxControlPathTemplate(dir)).toBe(`${dir}/%C`);
    expect(
      expandedMuxControlPathBytes(dir) + OPENSSH_CONTROL_PATH_TEMP_SUFFIX,
    ).toBeLessThanOrEqual(UNIX_DOMAIN_SOCKET_PATH_LIMIT);
    expect(muxControlPathFitsUnixLimit(dir)).toBe(true);
  });

  it("isolates mux dirs by Junto home and uid", () => {
    const prod = sshMuxControlDir("/Users/operator", 501);
    const dev = sshMuxControlDir("/Users/operator/.junto-dev", 501);
    const other = sshMuxControlDir("/Users/operator", 502);
    expect(prod).not.toBe(dev);
    expect(prod).not.toBe(other);
  });

  it("rejects the previous cm-v1 home-nested ControlPath that overflowed macOS", () => {
    const previous = join(
      "/Users/developer-with-a-long-home-name",
      ".junto",
      "ssh",
    );
    const overflowed = join(previous, `cm-v1-${"a".repeat(40)}`);
    expect(
      Buffer.byteLength(overflowed, "utf8") + OPENSSH_CONTROL_PATH_TEMP_SUFFIX,
    ).toBeGreaterThan(UNIX_DOMAIN_SOCKET_PATH_LIMIT);
    const longHome = join(
      "/Users/developer-with-a-long-home-name",
      ".junto-dev",
      ".junto",
      "ssh",
    );
    expect(muxControlPathFitsUnixLimit(longHome)).toBe(false);
    expect(() => assertMuxControlDirBudget(longHome)).toThrow(
      /Unix domain socket path limit/u,
    );
    expect(() =>
      createSshProgramCompiler({
        controlDir: longHome,
        envExecutable: "/usr/bin/env",
        sshExecutable: "/usr/bin/ssh",
        environment: { HOME: "/Users/developer-with-a-long-home-name", PATH: "/usr/bin:/bin" },
      }),
    ).toThrow(/Unix domain socket path limit/u);
  });
});
