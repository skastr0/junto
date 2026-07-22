import { describe, expect, it } from "vitest";
import {
  parseDeployTransferResult,
  resolveLocalAppBundle,
} from "../src/main/vellum/hosts/deploy-remote";

describe("resolveLocalAppBundle", () => {
  it("returns a string path or null without throwing", () => {
    // In CI / bare checkout there may be no .app; function must stay pure-safe.
    const path = resolveLocalAppBundle();
    expect(path === null || (typeof path === "string" && path.length > 0)).toBe(
      true,
    );
  });
});

describe("parseDeployTransferResult", () => {
  it("recognizes full and term-only readiness markers", () => {
    expect(
      parseDeployTransferResult({
        stdout: "STATION_READY term=1 browser=1",
        stderr: "",
      }),
    ).toMatchObject({
      ok: true,
      detail: expect.stringContaining("term + browser"),
    });
    expect(
      parseDeployTransferResult({
        stdout: "TERM_SOCK_OK browser=0",
        stderr: "",
      }),
    ).toMatchObject({
      ok: true,
      detail: expect.stringContaining("term control ready"),
    });
  });

  it("keeps a successful install honest when no readiness marker arrived", () => {
    expect(
      parseDeployTransferResult({
        stdout: "",
        stderr: "STATION_PARTIAL term=0 browser=0",
      }),
    ).toMatchObject({
      ok: true,
      detail: expect.stringContaining("still be warming"),
    });
  });
});
