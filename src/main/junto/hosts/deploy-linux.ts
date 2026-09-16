/** Owner-home Linux runtime deployment. No package manager or elevation lane. */
import { lstat } from "node:fs/promises";
import { Effect } from "effect";
import type { HostPackage } from "@shared/host-runtime";
import { LINUX_RELEASE_TARGET } from "../../../../scripts/linux-release-bundle";
import type { SshTarget } from "../ssh/domain";
import { formatSshFailure } from "../ssh/format";
import { oneShot } from "../ssh/program";
import { compileLinuxUserlandObserve, compileLinuxUserlandRestart } from "../ssh/remote-plan";
import type { SshTransportShape } from "../ssh/service";
import { authorizeProductionLinuxDeployBundle, openVerifiedProductionLinuxDeployPackage, verifyProductionLinuxDeployBundle, verifyQualificationLinuxDeployBundle, type ProductionLinuxDeployBundleAdmission } from "./linux-release-admission";
import { ensureLinuxReleaseCache, type LinuxReleaseCacheSource } from "./linux-release-feed";
import type { DeployRemoteResult, RemoteDeploymentTarget } from "./remote-deployment";

const RESTART_OK = /^LINUX_USERLAND_RESTART_V1 ok=1$/u;
const RESTART_FAIL = /^LINUX_USERLAND_RESTART_V1 ok=0 reason=([a-z-]+)$/u;
const OBSERVE = /^LINUX_USERLAND_OBSERVE_V1 present=([01])$/u;

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
