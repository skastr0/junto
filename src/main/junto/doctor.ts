/**
 * The window's doctor: every service's own answer, as one document. It runs
 * in the core, where those services live; the station facts only Electron
 * knows (this installation's version and user data path) come in from main
 * with the call (`ipc.doctor.report`).
 */
import { existsSync } from "node:fs";
import { Effect } from "effect";
import type { DoctorReport, ServiceCheck, StationInfo } from "@shared/contracts";
import { termControlSocketPath } from "@shared/term-control";
import { CodexService } from "../services/codex";
import { HostsService } from "./hosts";
import { primeHostsSnapshot } from "./hosts/snapshot";
import { KernelService } from "./kernel/service";
import { ModelService } from "./model/service";
import { SettingsService } from "./settings/service";
import { termPlane } from "./term/plane";
import { assessNativeTerminalDoctor, probeNativeTerminalReadiness } from "./term/native-readiness";
import { linuxDesktopInstallStorageDoctor } from "./update/linux-install";
import { UsageService } from "./usage/usage-service";

export const buildDoctorReport = (station: StationInfo) =>
  Effect.gen(function* () {
    // Ensure registry snapshot is current before host-aware doctor / transports.
    yield* Effect.tryPromise({
      try: () => primeHostsSnapshot(),
      catch: () => undefined,
    }).pipe(Effect.ignore);

    const codex = yield* CodexService;
    const model = yield* ModelService;
    const kernel = yield* KernelService;
    const usage = yield* UsageService;
    const settings = yield* SettingsService;
    const hosts = yield* HostsService;

    const hostsDoctorSnapshot = yield* hosts.doctorSnapshot;

    const serviceResults = yield* Effect.all(
      [
        codex.doctor,
        model.listCanvases().pipe(Effect.match({
          onFailure: () => ({ id: "canvases", label: "Canvases", status: "error" as const, detail: "Canvas storage is unavailable" }),
          onSuccess: (names) => ({ id: "canvases", label: "Canvases", status: "ok" as const, detail: `${names.length} canvases` }),
        })),
        kernel.doctor,
        usage.doctor,
        settings.doctor,
        Effect.succeed(hostsDoctorSnapshot.check),
      ],
      { concurrency: "unbounded" },
    );

    const running = termPlane.router.runningCount();
    const sockOk = existsSync(termControlSocketPath());
    const nativeTerminalProbe = yield* Effect.promise(() =>
      probeNativeTerminalReadiness()
    );
    const terminalCheck = assessNativeTerminalDoctor({
      probe: nativeTerminalProbe,
      controlReady: sockOk,
      running,
    });
    const linuxInstallStorage = process.platform === "linux"
      ? yield* Effect.promise(() => linuxDesktopInstallStorageDoctor({ executablePath: process.execPath }))
      : undefined;
    const services: ReadonlyArray<ServiceCheck> = [
      ...serviceResults,
      terminalCheck,
      ...(linuxInstallStorage === undefined ? [] : [linuxInstallStorage]),
    ];
    const recommendations = services
      .filter((service) => service.status !== "ok")
      .map((service) => `${service.label}: ${service.detail}`);

    return {
      checkedAt: new Date().toISOString(),
      station,
      services,
      recommendations,
    } satisfies DoctorReport;
  });
