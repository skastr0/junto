import { describe, expect, it } from "vitest";
import {
  SshExitError,
  SshProcessError,
  SshSetupError,
  SshTimeoutError,
} from "../src/main/vellum-command/ssh/domain";
import { classifySshStderr, formatSshFailure } from "../src/main/vellum-command/ssh/format";

describe("SSH failure formatting", () => {
  it("classifies known OpenSSH failures without copying remote bytes", () => {
    expect(
      classifySshStderr(
        "debug1: connecting\nunix_listener: path \"/tmp/secret.sock\" too long for Unix domain socket\n",
      ),
    ).toBe("SSH control socket path is too long for this OS");
    expect(classifySshStderr("Host key verification failed.\n")).toBe(
      "host key verification failed",
    );
    expect(classifySshStderr("secret-token\u001b[31m")).toBeUndefined();
  });

  it("prefers the classified diagnostic on exit failures", () => {
    expect(
      formatSshFailure(
        new SshExitError({
          endpoint: "remote-a",
          operation: "master-warm",
          code: 255,
          detail: "SSH control socket path is too long for this OS",
        }),
      ),
    ).toBe("SSH control socket path is too long for this OS");
    expect(
      formatSshFailure(
        new SshExitError({
          endpoint: "remote-a",
          operation: "master-warm",
          code: 255,
        }),
      ),
    ).toBe("ssh exited 255 during master-warm");
    expect(
      formatSshFailure(
        new SshTimeoutError({
          endpoint: "remote-a",
          operation: "master-warm",
          timeoutMs: 8_000,
        }),
      ),
    ).toBe("SSH timed out after 8000ms (master-warm)");
    expect(
      formatSshFailure(
        new SshSetupError({
          endpoint: "remote-a",
          message: "SSH control directory could not be secured",
        }),
      ),
    ).toBe("SSH control directory could not be secured");
    expect(
      formatSshFailure(
        new SshProcessError({
          endpoint: "remote-a",
          operation: "transfer",
          message: "SSH transfer closed before it finished",
        }),
      ),
    ).toBe("SSH transfer closed before it finished");
  });
});
