/** Owner-home Linux runtime deployment. No package manager or elevation lane. */
import { lstat } from "node:fs/promises";
import { Effect, Stream } from "effect";
import type { HostPackage } from "@shared/host-runtime";
import { LINUX_RELEASE_TARGET } from "../../../../scripts/linux-release-bundle";
import { makeRemoteStdin, type SshTarget } from "../ssh/domain";
import { formatSshFailure } from "../ssh/format";
import { deploymentStream, oneShot, oneShotWithStdin } from "../ssh/program";
import { compileLinuxUserlandDeploy, compileLinuxUserlandObserve, compileLinuxUserlandPreflight, compileLinuxUserlandRestart } from "../ssh/remote-plan";
import type { SshTransportShape } from "../ssh/service";
import { authorizeProductionLinuxDeployBundle, openVerifiedProductionLinuxDeployPackage, verifyProductionLinuxDeployBundle, verifyQualificationLinuxDeployBundle, type ProductionLinuxDeployBundleAdmission } from "./linux-release-admission";
import { ensureLinuxReleaseCache, type LinuxReleaseCacheSource } from "./linux-release-feed";
import type { DeployRemoteResult, RemoteDeploymentProvider, RemoteDeploymentProviderInput, RemoteDeploymentTarget } from "./remote-deployment";

const SHA256 = /^[0-9a-f]{64}$/u;
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const PREFLIGHT_OK = /^LINUX_USERLAND_PREFLIGHT_V1 ok=1 uid=([1-9][0-9]*) free=([1-9][0-9]*)$/u;
const PREFLIGHT_FAIL = /^LINUX_USERLAND_PREFLIGHT_V1 ok=0 reason=([a-z-]+)$/u;
const DEPLOY = /^LINUX_USERLAND_DEPLOY_V1 ok=1 state=(ready|idempotent) release=([0-9]+\.[0-9]+\.[0-9]+-[0-9a-f]{64})$/u;
const RESTART_OK = /^LINUX_USERLAND_RESTART_V1 ok=1$/u;
const RESTART_FAIL = /^LINUX_USERLAND_RESTART_V1 ok=0 reason=([a-z-]+)$/u;
const OBSERVE = /^LINUX_USERLAND_OBSERVE_V1 present=([01])$/u;

export interface LinuxRemotePreflightEvidence { readonly ok: boolean; readonly uid?: number; readonly availableBytes?: number; readonly reason?: string; }
export const decodeLinuxRemotePreflight = (stdout: string): LinuxRemotePreflightEvidence => {
  const line = stdout.trim();
  const ok = PREFLIGHT_OK.exec(line);
  if (ok) return { ok: true, uid: Number(ok[1]), availableBytes: Number(ok[2]) };
  const fail = PREFLIGHT_FAIL.exec(line);
  return { ok: false, reason: fail?.[1] ?? "malformed" };
};

const linuxPreflightFailureDetail = (reason: string | undefined): string => {
  switch (reason) {
    case "systemd-user":
      return "owner-local systemd user service is unavailable";
    case "disk":
      return "no space left on device";
    case "identity":
      return "owner identity is not a deployable userland uid";
    case "home-link":
      return "owner home .vellum-command must not be a symlink";
    case "runtime":
      return "owner-home runtime directories could not be prepared";
    default:
      return "userland runtime preflight failed";
  }
};

export const decodeLinuxRemoteRestart = (
  stdout: string,
): { readonly ok: boolean; readonly reason?: string } => {
  const line = stdout.trim();
  if (RESTART_OK.test(line)) return { ok: true };
  const fail = RESTART_FAIL.exec(line);
  return { ok: false, reason: fail?.[1] ?? "malformed" };
};

export type LinuxRemoteObserveEvidence =
  | { readonly ok: true; readonly present: boolean }
  | { readonly ok: false };

export const decodeLinuxRemoteObserve = (
  stdout: string,
): LinuxRemoteObserveEvidence => {
  const match = OBSERVE.exec(stdout.trim());
  if (!match) return { ok: false };
  return { ok: true, present: match[1] === "1" };
};

export const linuxObserveToHostPackage = (
  evidence: LinuxRemoteObserveEvidence,
): HostPackage =>
  evidence.ok ? (evidence.present ? "present" : "absent") : "unknown";

/** Userland generation present or absent. Probe failure stays unknown. */
export const observeLinuxUserlandPackage = (
  ssh: SshTransportShape,
  target: SshTarget,
): Effect.Effect<HostPackage> =>
  Effect.gen(function* () {
    const command = yield* compileLinuxUserlandObserve().pipe(Effect.result);
    if (command._tag === "Failure") return "unknown";
    const ran = yield* ssh
      .run(oneShot(target, command.success, { budget: "short" }))
      .pipe(Effect.result);
    if (ran._tag === "Failure") return "unknown";
    return linuxObserveToHostPackage(decodeLinuxRemoteObserve(ran.success.stdout));
  });

const linuxRestartFailureDetail = (reason: string | undefined): string => {
  switch (reason) {
    case "systemd-user":
      return "owner-local systemd user service is unavailable";
    case "reload":
      return "systemd user daemon-reload failed";
    case "restart":
      return "systemd user service restart failed";
    case "inactive":
      return "systemd user service is not active after restart";
    default:
      return "linux remote runtime restart failed";
  }
};

export const activateLinuxRemoteRuntimeForTarget = (
  ssh: SshTransportShape,
  target: RemoteDeploymentTarget,
): Effect.Effect<DeployRemoteResult, never> =>
  Effect.gen(function* () {
    const stages = [...target.progress];
    const command = yield* compileLinuxUserlandRestart().pipe(Effect.result);
    if (command._tag === "Failure") {
      return {
        ok: false,
        detail: `${target.host.label}: linux remote restart program is unavailable`,
        code: "validation" as const,
        message: "linux remote restart program is unavailable",
        stages,
        disposition: "indeterminate" as const,
      };
    }
    const ran = yield* ssh
      .run(oneShot(target.sshTarget, command.success, { budget: "bulk" }))
      .pipe(Effect.result);
    if (ran._tag === "Failure") {
      const detail = `${target.host.label}: linux remote runtime restart failed — ${formatSshFailure(ran.failure)}`;
      return {
        ok: false,
        detail,
        code: "io" as const,
        message: detail,
        stages,
        disposition: "indeterminate" as const,
      };
    }
    const decoded = decodeLinuxRemoteRestart(ran.success.stdout);
    if (!decoded.ok) {
      const message = linuxRestartFailureDetail(decoded.reason);
      return {
        ok: false,
        detail: `${target.host.label}: ${message}`,
        code: decoded.reason === "systemd-user" ? ("validation" as const) : ("io" as const),
        message,
        stages,
        disposition: "indeterminate" as const,
      };
    }
    const detail = `${target.host.label}: systemd user service restarted`;
    stages.push(detail);
    return {
      ok: true,
      detail,
      stages,
      disposition: "ready" as const,
    };
  });

export const buildLinuxRemotePreflightScript = () => "userland runtime preflight";
export const buildLinuxRemoteDeployCommand = () => Object.freeze({ executable: "/bin/sh", args: [] as const });

export interface LinuxRemoteArtifactAdmission { readonly version: string; readonly bytes: number; readonly sha256: string; readonly open: () => Promise<AsyncIterable<Uint8Array>>; }
export interface LinuxRemoteArtifactCandidate { readonly version: string; readonly bytes: number; readonly sha256: string; readonly authorize: () => LinuxRemoteArtifactAdmission; }
export type LinuxRemoteArtifactAuthority = { readonly resolve: () => Promise<LinuxRemoteArtifactCandidate>; };

const admitted = (bundle: ProductionLinuxDeployBundleAdmission): LinuxRemoteArtifactAdmission => Object.freeze({
  version: bundle.version, bytes: bundle.bytes, sha256: bundle.sha256,
  open: async () => {
    const opened = await openVerifiedProductionLinuxDeployPackage(bundle);
    return (async function* () { try { for await (const chunk of opened.stream) yield Uint8Array.from(chunk); } finally { opened.stream.destroy(); await opened.handle.close(); } })();
  },
});

export const makeProductionLinuxArtifactAuthority = (input: { readonly home?: string; readonly source?: LinuxReleaseCacheSource } = {}): LinuxRemoteArtifactAuthority => ({
  resolve: async () => {
    const source = input.source ?? "stable-feed";
    const cache = await ensureLinuxReleaseCache({ ...(input.home === undefined ? {} : { home: input.home }), source });
    const metadata = await lstat(cache.bundleRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o022) !== 0) throw new Error("Linux release cache is not owner controlled");
    const candidate = source === "qualification-candidate" ? await verifyQualificationLinuxDeployBundle({ bundleDirectory: cache.bundleRoot }) : await verifyProductionLinuxDeployBundle({ bundleDirectory: cache.bundleRoot });
    return Object.freeze({ version: candidate.version, bytes: candidate.bytes, sha256: candidate.sha256, authorize: () => admitted(authorizeProductionLinuxDeployBundle(candidate, { remoteTarget: { distribution: "ubuntu", distributionVersion: "24.04", architecture: "x86_64", libcFamily: "glibc", libcVersion: LINUX_RELEASE_TARGET.libc.minimumVersion } })) });
  },
});

export type LinuxRemoteLiveWorkAuthority = { readonly acquire: (input: RemoteDeploymentProviderInput, live: boolean, proof: () => Promise<unknown>) => Effect.Effect<{ readonly acquired: boolean; readonly reason?: "active-terminal-sessions" | "maintenance-held" | "shutting-down"; readonly evidence: { readonly activeTerminalSessions: number; readonly observationId: string }; readonly release?: Effect.Effect<void, never> }, Error>; };
export const makeProductionLinuxLiveWorkAuthority = (): LinuxRemoteLiveWorkAuthority => ({ acquire: () => Effect.succeed({ acquired: true, evidence: { activeTerminalSessions: 0, observationId: "userland-deploy" }, release: Effect.void }) });

const failure = (input: RemoteDeploymentProviderInput, detail: string, code: NonNullable<DeployRemoteResult["code"]> = "io"): DeployRemoteResult => ({ ok: false, detail: `${input.target.host.label}: ${detail}`, message: detail, code, stages: input.target.progress, disposition: "not-started" });
const runPreflight = (input: RemoteDeploymentProviderInput) => Effect.gen(function* () { const command = yield* compileLinuxUserlandPreflight(); const stdin = yield* makeRemoteStdin(""); const result = yield* input.ssh.run(oneShotWithStdin(input.target.sshTarget, command, stdin)); return decodeLinuxRemotePreflight(result.stdout); });

export const makeLinuxRemoteDeploymentProvider = (input: { readonly artifactAuthority: LinuxRemoteArtifactAuthority; readonly artifactAuthorityBySource?: (source: LinuxReleaseCacheSource) => LinuxRemoteArtifactAuthority; readonly liveWorkAuthority: LinuxRemoteLiveWorkAuthority; }): RemoteDeploymentProvider => ({
  // Linux beta Remote is displayless Node: browser is intentionally unavailable
  // (not a core failure). Explicit browser host requests fail closed upstream
  // before upload/activation — never offer sudo/Xvfb/Electron remediation.
  platform: "linux", supportsBrowser: false,
  deploy: (request) =>
    Effect.scoped(
      Effect.gen(function* () {
        if (request.target.platform.platform !== "linux") {
          return failure(
            request,
            "Linux deployment provider refused a non-Linux target",
            "validation",
          );
        }
        const candidate = yield* Effect.tryPromise({
          try: () =>
            (
              input.artifactAuthorityBySource?.(request.artifactSource) ??
              input.artifactAuthority
            ).resolve(),
          catch: () => new Error("signed userland runtime archive unavailable"),
        }).pipe(Effect.result);
        if (
          candidate._tag === "Failure" ||
          !SEMVER.test(candidate.success.version) ||
          !SHA256.test(candidate.success.sha256)
        ) {
          return failure(
            request,
            "signed userland runtime archive is invalid",
            "validation",
          );
        }
        const preflight = yield* runPreflight(request).pipe(Effect.result);
        if (preflight._tag === "Failure") {
          return failure(request, formatSshFailure(preflight.failure), "io");
        }
        if (!preflight.success.ok) {
          return failure(
            request,
            linuxPreflightFailureDetail(preflight.success.reason),
            "validation",
          );
        }
        const archive = candidate.success.authorize();
        const command = yield* compileLinuxUserlandDeploy().pipe(Effect.result);
        if (command._tag === "Failure") {
          return failure(request, "userland deploy program is unavailable");
        }
        const outcome = yield* request.ssh
          .transact(
            deploymentStream(request.target.sshTarget, command.success),
            (lease) =>
              Effect.scoped(
                Effect.gen(function* () {
                  yield* lease.write(
                    Buffer.from(
                      `LINUX_USERLAND_DEPLOY_V1 version=${archive.version} sha256=${archive.sha256} bytes=${archive.bytes}\n`,
                    ),
                  );
                  yield* Stream.runForEach(
                    Stream.fromAsyncIterable(
                      yield* Effect.promise(archive.open),
                      (e) =>
                        e instanceof Error ? e : new Error(String(e)),
                    ),
                    (chunk) => lease.write(chunk),
                  );
                  yield* lease.closeInput;
                  const stdout = yield* Stream.runCollect(lease.stdout).pipe(
                    Effect.map((chunks) =>
                      Buffer.concat(
                        Array.from(chunks).map(Buffer.from),
                      ).toString("utf8"),
                    ),
                  );
                  return stdout;
                }),
              ),
          )
          .pipe(Effect.result);
        if (outcome._tag === "Failure") {
          return failure(request, "userland runtime transfer failed");
        }
        const ready = DEPLOY.exec(outcome.success.trim());
        if (ready && ready[2] === `${archive.version}-${archive.sha256}`) {
          return {
            ok: true,
            detail: `${request.target.host.label}: userland runtime ${ready[1]}`,
            stages: request.target.progress,
            disposition: "ready" as const,
            version: archive.version,
          };
        }
        if (/LINUX_USERLAND_DEPLOY_V1 ok=0/u.test(outcome.success)) {
          return failure(request, "candidate failed before activation");
        }
        return {
          ok: false,
          detail: `${request.target.host.label}: userland runtime did not prove LINUX_USERLAND_DEPLOY_V1 ok=1`,
          message: "userland runtime did not prove LINUX_USERLAND_DEPLOY_V1 ok=1",
          code: "io" as const,
          stages: request.target.progress,
          disposition: "indeterminate" as const,
          version: archive.version,
        };
      }),
    ).pipe(
      // Provider contract is errorless: any residual Effect failure becomes a
      // structured DeployRemoteResult (never an uncaught channel error).
      Effect.catchDefect((defect) =>
        Effect.succeed(
          failure(
            request,
            defect instanceof Error ? defect.message : String(defect),
          ),
        ),
      ),
    ) as Effect.Effect<DeployRemoteResult, never>,
});

export const linuxRemoteDeploymentProvider = makeLinuxRemoteDeploymentProvider({ artifactAuthority: makeProductionLinuxArtifactAuthority(), liveWorkAuthority: makeProductionLinuxLiveWorkAuthority() });
