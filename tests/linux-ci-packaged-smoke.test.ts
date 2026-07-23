import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { ProcessRow } from "../scripts/packaged-runtime-smoke";
import {
  auditSandboxedRenderers,
  parseProcSandboxStatus,
  parseWorkCliSchemaReceipt,
  requireXvfbDisplay,
  validateAppArmorLabel,
} from "../scripts/linux-ci-packaged-smoke";

const sandboxStatus = `
Name:\tvellum
NoNewPrivs:\t1
Seccomp:\t2
Seccomp_filters:\t2
`;

describe("Linux packaged Xvfb smoke contract", () => {
  it("requires an Xvfb-shaped display", () => {
    expect(requireXvfbDisplay(":99")).toBe(":99");
    expect(requireXvfbDisplay(":101.0")).toBe(":101.0");
    expect(() => requireXvfbDisplay(undefined)).toThrow(/Xvfb DISPLAY/u);
    expect(() => requireXvfbDisplay("wayland-0")).toThrow(/Xvfb DISPLAY/u);
    expect(() => requireXvfbDisplay("localhost:10.0")).toThrow(/Xvfb DISPLAY/u);
  });

  it("requires no-new-privileges and filtered seccomp on renderers", () => {
    expect(parseProcSandboxStatus(sandboxStatus)).toEqual({
      noNewPrivs: 1,
      seccomp: 2,
      seccompFilters: 2,
    });
    expect(() =>
      parseProcSandboxStatus(sandboxStatus.replace("NoNewPrivs:\t1", "NoNewPrivs:\t0")),
    ).toThrow(/sandboxing/u);
    expect(() =>
      parseProcSandboxStatus(sandboxStatus.replace("Seccomp:\t2", "Seccomp:\t0")),
    ).toThrow(/sandboxing/u);
    expect(() =>
      parseProcSandboxStatus(sandboxStatus.replace("Seccomp_filters:\t2", "Seccomp_filters:\t0")),
    ).toThrow(/sandboxing/u);
  });

  it("checks every renderer and rejects sandbox-disabling switches", async () => {
    const rows: ProcessRow[] = [
      { pid: 10, ppid: 1, command: "/opt/Vellum Command/vellum" },
      {
        pid: 11,
        ppid: 10,
        command: "/opt/Vellum Command/vellum --type=renderer",
      },
      {
        pid: 12,
        ppid: 10,
        command: "/opt/Vellum Command/vellum --type=renderer",
      },
    ];
    const checked: number[] = [];
    await expect(auditSandboxedRenderers(rows, async (pid) => {
      checked.push(pid);
      return sandboxStatus;
    })).resolves.toEqual({
      renderers: 2,
      noNewPrivs: true,
      seccomp: true,
    });
    expect(checked.sort()).toEqual([11, 12]);

    await expect(auditSandboxedRenderers(
      [
        ...rows,
        {
          pid: 13,
          ppid: 10,
          command: "/opt/Vellum Command/vellum --no-sandbox",
        },
      ],
      async () => sandboxStatus,
    )).rejects.toThrow(/disabled/u);
  });

  it("requires AppArmor enabled and the installed Vellum label", () => {
    expect(validateAppArmorLabel("Y\n", "vellum (unconfined)\n")).toBe(
      "vellum",
    );
    expect(() =>
      validateAppArmorLabel("N\n", "vellum (unconfined)\n"),
    ).toThrow(/not enabled/u);
    expect(() =>
      validateAppArmorLabel("Y\n", "unconfined\n"),
    ).toThrow(/installed AppArmor/u);
  });

  it("requires a live packaged work CLI schema envelope", () => {
    expect(() =>
      parseWorkCliSchemaReceipt(JSON.stringify({
        ok: true,
        data: { schemas: [{ command: "doctor" }] },
      })),
    ).not.toThrow();
    expect(() =>
      parseWorkCliSchemaReceipt(JSON.stringify({
        ok: true,
        data: { schemas: [] },
      })),
    ).toThrow(/inventory is missing/u);
    expect(() => parseWorkCliSchemaReceipt("not json")).toThrow(/non-JSON/u);
  });

  it("uses the central process plane and has no ambient termination path", async () => {
    const source = await readFile(
      new URL("../scripts/linux-ci-packaged-smoke.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("createAppProcessPlane()");
    expect(source).toContain("spawnGroup");
    expect(source).toContain("terminateSpawnedRuntime");
    expect(source).toContain("finalizePackagedRuntimeSandbox");
    expect(source).not.toMatch(/\bprocess\.kill\s*\(|\bkill\s+-/u);
    expect(source).not.toContain("--no-sandbox");
    expect(source).not.toContain("--disable-setuid-sandbox");
  });
});
