import { describe, expect, it, vi } from "vitest";
import {
  TerminalLaunchError,
  validateExecutableShell,
  type ShellFilesystem,
} from "../src/main/vellum/term/shell-policy";

const filesystem = (input?: {
  readonly regular?: boolean;
  readonly accessError?: Error;
}): ShellFilesystem => ({
  stat: vi.fn(() => ({ isFile: () => input?.regular ?? true })),
  accessExecutable: vi.fn(() => {
    if (input?.accessError !== undefined) throw input.accessError;
  }),
});

describe("terminal shell executable policy", () => {
  it("checks X_OK only after proving the path is a regular file", () => {
    const order: string[] = [];
    const fs: ShellFilesystem = {
      stat: () => {
        order.push("stat");
        return { isFile: () => true };
      },
      accessExecutable: () => {
        order.push("access:X_OK");
      },
    };

    expect(validateExecutableShell("/opt/vellum/shell", fs)).toBe(
      "/opt/vellum/shell",
    );
    expect(order).toEqual(["stat", "access:X_OK"]);
  });

  it("returns typed errors for relative, missing, non-regular, and inaccessible shells", () => {
    const failureCode = (run: () => void): TerminalLaunchError["code"] => {
      try {
        run();
      } catch (error) {
        expect(error).toBeInstanceOf(TerminalLaunchError);
        return (error as TerminalLaunchError).code;
      }
      throw new Error("expected terminal shell validation to fail");
    };

    expect(failureCode(() => validateExecutableShell("bash", filesystem()))).toBe(
      "shell_not_absolute",
    );

    const missing = filesystem();
    vi.mocked(missing.stat).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(failureCode(() => validateExecutableShell("/missing/bash", missing))).toBe(
      "shell_missing",
    );

    const directory = filesystem({ regular: false });
    expect(failureCode(() => validateExecutableShell("/not/a/file", directory))).toBe(
      "shell_missing",
    );
    expect(directory.accessExecutable).not.toHaveBeenCalled();

    const denied = filesystem({ accessError: new Error("EACCES") });
    expect(failureCode(() => validateExecutableShell("/present/bash", denied))).toBe(
      "shell_not_executable",
    );
    expect(denied.accessExecutable).toHaveBeenCalledWith("/present/bash");
  });
});
