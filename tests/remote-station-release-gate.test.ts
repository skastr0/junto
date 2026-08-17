import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  STATION_PORTFOLIO_PROTOCOL,
  STATION_PORTFOLIO_PROTOCOL_VERSION,
  decodeStationPortfolioBody,
} from "../src/main/vellum/station/portfolio";
import { STATION_READINESS_VERSION } from "../src/main/vellum/station-readiness";
import { STATION_API_PROTOCOL } from "../src/shared/station-api";
import { STATION_CONTROL_PROTOCOL } from "../src/shared/station-api-envelope";
import {
  CURRENT_STATION_PROTOCOL_SUPPORT,
  STATION_PROTOCOL_BASELINE,
} from "../src/shared/station-protocol";
import {
  STATION_QUALIFICATION_SCHEMA,
  STATION_QUALIFICATION_SCHEMA_VERSION,
} from "../src/shared/station-qualification";
import { STATION_SESSION_PROTOCOL } from "../src/shared/station-session";
import { STATION_STATUS_VERSION } from "../src/shared/station-status";
import { REMOTE_HOSTS_VERSION } from "../src/shared/remote-hosts";
import {
  REMOTE_STATIONS_RELEASE_STATE,
  REMOTE_STATIONS_RELEASED,
  remoteStationContractVersion,
} from "../src/shared/remote-station-release";
import { TERM_CONTROL_PROTOCOL } from "../src/shared/term-control";

const source = (relative: string): string =>
  readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

describe("unreleased Remote Station contract gate", () => {
  it("keeps every Remote Station contract at version 1", () => {
    expect(REMOTE_STATIONS_RELEASE_STATE).toBe(
      "REMOTE STATIONS ARE NOT RELEASED",
    );
    expect(REMOTE_STATIONS_RELEASED).toBe("REMOTE STATIONS ARE RELEASED");
    expect(STATION_PROTOCOL_BASELINE).toBe(1);
    expect(CURRENT_STATION_PROTOCOL_SUPPORT).toEqual({
      preferred: 1,
      compatibleFrom: 1,
      warnBelow: 1,
    });
    expect(STATION_API_PROTOCOL).toBe("vellum-command/station-api/v1");
    expect(STATION_SESSION_PROTOCOL).toBe(
      "vellum-command/station-session/v1",
    );
    expect(STATION_CONTROL_PROTOCOL).toBe(
      "vellum-command/station-control/v1",
    );
    expect(TERM_CONTROL_PROTOCOL).toBe(1);
    expect(STATION_PORTFOLIO_PROTOCOL_VERSION).toBe(1);
    expect(STATION_PORTFOLIO_PROTOCOL).toBe(
      "vellum-command/station-portfolio/v1",
    );
    expect(STATION_QUALIFICATION_SCHEMA_VERSION).toBe(1);
    expect(STATION_QUALIFICATION_SCHEMA).toBe(
      "vellum-command/station-two-installation-qualification/v1",
    );
    expect(STATION_STATUS_VERSION).toBe(1);
    expect(REMOTE_HOSTS_VERSION).toBe(1);
    expect(STATION_READINESS_VERSION).toBe(1);
  });

  it("forbids a version bump at typecheck and module initialization", () => {
    expect(remoteStationContractVersion("test contract", 1)).toBe(1);
    if (false) {
      // @ts-expect-error Remote Station versions cannot exceed 1 before release.
      remoteStationContractVersion("compile-time refusal", 2);
    }
    const unsafeVersion = remoteStationContractVersion as (
      contract: string,
      version: number,
    ) => number;
    expect(() => unsafeVersion("runtime refusal", 2)).toThrow(
      'until REMOTE_STATIONS_RELEASE_STATE is "REMOTE STATIONS ARE RELEASED"',
    );
  });

  it("requires every independent Remote Station version to use the gate", () => {
    const station = source("src/shared/station-protocol.ts");
    const term = source("src/shared/term-control.ts");
    const portfolio = source("src/main/vellum/station/portfolio.ts");
    const qualification = source("src/shared/station-qualification.ts");
    const status = source("src/shared/station-status.ts");
    const remoteHosts = source("src/shared/remote-hosts.ts");
    const readiness = source("src/main/vellum/station-readiness.ts");

    for (const [path, body] of [
      ["station-protocol.ts", station],
      ["term-control.ts", term],
      ["station/portfolio.ts", portfolio],
      ["station-qualification.ts", qualification],
      ["station-status.ts", status],
      ["remote-hosts.ts", remoteHosts],
      ["station-readiness.ts", readiness],
    ] as const) {
      expect(body, path).toContain("remoteStationContractVersion(");
    }
    expect(term).not.toContain("STATION_PROTOCOL_BASELINE");
  });

  it("emits v1 and keeps only the frozen SQLite portfolio decode exception", () => {
    const body = (protocol: string) =>
      JSON.stringify({ protocol, documents: [], actorSeats: [] });

    expect(decodeStationPortfolioBody(body(STATION_PORTFOLIO_PROTOCOL))).toEqual(
      { documents: new Map(), actorSeats: [] },
    );
    expect(
      decodeStationPortfolioBody(body("vellum/station-portfolio/v2")),
    ).toEqual({ documents: new Map(), actorSeats: [] });
    expect(() =>
      decodeStationPortfolioBody(
        body("vellum-command/station-portfolio/v2"),
      ),
    ).toThrow("projection body violates the portfolio contract");
  });
});
