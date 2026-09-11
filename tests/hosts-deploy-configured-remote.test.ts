import { readFileSync } from "node:fs";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { InstallationId } from "../src/shared/station-api";
import { RemoteHostsError, type RemoteHost } from "../src/shared/remote-hosts";
import {
  alreadyConfiguredActivateFailure,
  configurationFailure,
  failedBeforeMutation,
  failedPackageResult,
  finishAlreadyConfiguredRemote,
  finishWithConfiguration,
  packageAdmitted,
} from "../src/main/vellum-command/hosts/deploy-configured-remote";
import type { DeployRemoteResult } from "../src/main/vellum-command/hosts/remote-deployment";

const installationId = Schema.decodeUnknownSync(InstallationId);

const host: RemoteHost = {
  id: "studio",
  hermesId: "fleet-studio",
  label: "Studio",
  kind: "remote",
  sshEndpoint: "studio-box",
  capabilities: ["hermes", "browser"],
};

const readyPackage: DeployRemoteResult = {
  ok: true,
  detail: "userland runtime ready",
  stages: ["target admitted", "deployed"],
  disposition: "ready",
  version: "1.2.3",
};

const configured = {
  ok: true as const,
  detail: "configured through Station API",
  stationInstallationId: installationId("station-installation"),
  configuredAt: "2026-07-27T12:00:02.000Z",
  station: {
    role: "remote" as const,
    hostId: "studio",
    agentHostId: "fleet-studio",
    supervisedPreferred: true,
  },
};

describe("configured remote deploy receipts", () => {
  it("admits a ready or enrollment package and rejects not-started", () => {
    expect(packageAdmitted(readyPackage)).toBe(true);
    expect(
      packageAdmitted({
        ...readyPackage,
        disposition: "configuration-required",
      }),
    ).toBe(true);
    expect(
      packageAdmitted({
        ok: false,
        detail: "signed userland runtime archive is invalid",
        stages: ["target admitted"],
        disposition: "not-started",
        code: "validation",
      }),
    ).toBe(false);
  });

  it("failedBeforeMutation leaves package and Station previous", () => {
    const result = failedBeforeMutation(
      host,
      "Linux Remote managed deployment is not available",
      { code: "validation" },
    );
    expect(result.ok).toBe(false);
    expect(result.packageState).toBe("previous");
    expect(result.role).toBe("previous");
    expect(result.disposition).toBe("not-started");
    expect(result.configuration.detail).toBe("Station API not called");
  });

  it("failedPackageResult stays previous only when deploy never started", () => {
    const notStarted = failedPackageResult(host, {
      ok: false,
      detail: "signed userland runtime archive is invalid",
      stages: ["target admitted"],
      disposition: "not-started",
      code: "validation",
    });
    expect(notStarted.outcome).toBe("failed");
    expect(notStarted.packageState).toBe("previous");
    expect(notStarted.role).toBe("previous");

    const indeterminate = failedPackageResult(host, {
      ok: false,
      detail: "enrollment socket timeout",
      stages: ["target admitted"],
      disposition: "indeterminate",
    });
    expect(indeterminate.outcome).toBe("indeterminate");
    expect(indeterminate.packageState).toBe("unknown");
    expect(indeterminate.role).toBe("previous");
  });

  it("configurationFailure keeps the package and does not claim remote", () => {
    const fromResult = configurationFailure(host, readyPackage, {
      ok: false,
      detail: "Station API pair refused",
      code: "conflict",
    });
    expect(fromResult.ok).toBe(false);
    expect(fromResult.packageState).toBe("present");
    expect(fromResult.role).toBe("unknown");
    expect(fromResult.configuration.ok).toBe(false);
    expect(fromResult.detail).toContain("Station API pair refused");

    const fromError = configurationFailure(
      host,
      readyPackage,
      new RemoteHostsError("conflict", "pair refused"),
    );
    expect(fromError.code).toBe("conflict");
    expect(fromError.message).toBe("pair refused");
  });

  it("finishWithConfiguration is ready Remote after Station pair", () => {
    const result = finishWithConfiguration(host, readyPackage, configured);
    expect(result.ok).toBe(true);
    expect(result.role).toBe("remote");
    expect(result.packageState).toBe("present");
    expect(result.disposition).toBe("ready");
    expect(result.stationInstallationId).toBe("station-installation");
    expect(result.detail).toContain("configured through Station API");
  });

  it("already-configured receipts skip configure and keep the prior id", () => {
    const prior = installationId("station-installation");
    const finished = finishAlreadyConfiguredRemote(
      host,
      readyPackage,
      prior,
      "supervised Remote runtime ready",
    );
    expect(finished.ok).toBe(true);
    expect(finished.stationInstallationId).toBe(prior);
    expect(finished.configuration.detail).toContain("configure skipped");
    expect(finished.detail).toContain("configure skipped");

    const failed = alreadyConfiguredActivateFailure(
      host,
      readyPackage,
      prior,
      "runtime activate did not prove term + browser sockets",
    );
    expect(failed.ok).toBe(false);
    expect(failed.role).toBe("remote");
    expect(failed.stationInstallationId).toBe(prior);
    expect(failed.configuration.ok).toBe(true);
    expect(failed.detail).toContain("runtime activate failed");
  });

  it("is receipt helpers, not a second Deploy apply loop", () => {
    const configuredRemote = readFileSync(
      new URL(
        "../src/main/vellum-command/hosts/deploy-configured-remote.ts",
        import.meta.url,
      ),
      "utf8",
    );
    expect(configuredRemote).toContain("packageAdmitted");
    expect(configuredRemote).toContain("finishWithConfiguration");
    expect(configuredRemote).toContain("failedPackageResult");
    expect(configuredRemote).not.toContain("deployConfiguredRemoteHost");
    expect(configuredRemote).not.toContain("dispatchRemoteDeployment");
    expect(configuredRemote).not.toContain("prepareRemoteDeployment");
    expect(configuredRemote).not.toContain("activateRuntime");
    expect(configuredRemote).not.toContain("darwinRemoteDeploymentProvider");
  });
});
