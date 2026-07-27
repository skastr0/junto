import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { Effect, Queue, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  LINUX_RELEASE_BRIDGE_AUTH_PROTOCOL,
  LINUX_RELEASE_BRIDGE_CLEAN_PROTOCOL,
  decodeLinuxReleaseBridgeStageRequest,
  encodeLinuxReleaseBridgeAuthArmed,
  encodeLinuxReleaseBridgeInventory,
  encodeLinuxReleaseBridgeStageCleared,
  type LinuxReleaseBridgeAuthArmed,
  type LinuxReleaseBridgeCleanupReason,
  type LinuxReleaseBridgeStageCleared,
  type LinuxReleaseBridgeStageRequest,
} from "../src/shared/linux-release-bridge";
import { LINUX_RELEASE_FENCE_PROTOCOL } from "../src/shared/linux-release-fence";
import {
  LINUX_RELEASE_INSTALLER_PROTOCOL,
  LINUX_RELEASE_INSTALLER_RECEIPT,
  decodeLinuxReleaseInstallerRequest,
  encodeLinuxReleaseInstallerReceipt,
  encodeLinuxReleaseInstallerRequest,
  type LinuxReleaseInstallerReceipt,
  type LinuxReleaseInstallerRequest,
} from "../src/shared/linux-release-installer";
import type { RemoteHost } from "../src/shared/remote-hosts";
import {
  buildLinuxRemoteDeployCommand,
  buildLinuxRemotePreflightScript,
  decodeLinuxRemotePreflight,
  makeLinuxRemoteDeploymentProvider,
  type LinuxRemoteArtifactAdmission,
  type LinuxRemoteArtifactCandidate,
  type LinuxRemoteLiveWorkAuthority,
} from "../src/main/vellum/hosts/deploy-linux";
import {
  mintLinuxAdministratorCredential,
  type LinuxAdministratorCredential,
  type LinuxAdministratorCredentialBinding,
} from "../src/main/vellum/hosts/linux-administrator-credential";
import type {
  RemoteDeploymentProvider,
  RemoteDeploymentProviderInput,
} from "../src/main/vellum/hosts/remote-deployment";
import {
  SshExitError,
  SshIoError,
  parseSshEndpoint,
  type SshEndpoint,
} from "../src/main/vellum/ssh/domain";
import type { SshLease } from "../src/main/vellum/ssh/service";

const sha256 = (bytes: Buffer | string): string =>
  createHash("sha256").update(bytes).digest("hex");

const endpoint = Effect.runSync(parseSshEndpoint("studio-box"));
const deb = Buffer.from("signed-deb");
const manifest = Buffer.from('{"signed":true}\n');
const debSha256 = sha256(deb);
const manifestSha256 = sha256(manifest);
const sourceRevision = "a".repeat(40);
const generation = "b".repeat(32);
const helperChallenge = "c".repeat(32);
const bridgeNonce = "d".repeat(32);
const fenceId = "e".repeat(32);
const machineIdSha256 = "f".repeat(64);
const bootId = "00000000-0000-4000-8000-000000000001";
const readinessReceiptSha256 = "1".repeat(64);

const files = Object.freeze([
  Object.freeze({
    name: "Vellum Command-1.2.3-x64-linux.deb",
    bytes: deb.byteLength,
    sha256: debSha256,
  }),
  Object.freeze({
    name: "release-manifest.json",
    bytes: manifest.byteLength,
    sha256: manifestSha256,
  }),
]);

const bundle = Buffer.concat([deb, manifest]);
const bundleBytes = bundle.byteLength;

const makeAdmission = (): LinuxRemoteArtifactAdmission =>
  Object.freeze({
    version: "1.2.3",
    bytes: deb.byteLength,
    sha256: debSha256,
    sourceRevision,
    manifestSha256,
    bundleBytes,
    files,
    openBundle: () => ({
      async *[Symbol.asyncIterator]() {
        for (const [index, file] of files.entries()) {
          yield Object.freeze({
            ...file,
            stream: Readable.from([index === 0 ? deb : manifest]),
          });
        }
      },
    }),
  });

const makeCandidate = (): LinuxRemoteArtifactCandidate => {
  const admitted = makeAdmission();
  return Object.freeze({
    version: admitted.version,
    bytes: admitted.bytes,
    sha256: admitted.sha256,
    manifestSha256: admitted.manifestSha256,
    bundleBytes: admitted.bundleBytes,
    authorize: vi.fn(() => admitted),
  });
};

const host: RemoteHost = {
  id: "studio",
  label: "Studio",
  kind: "remote",
  sshEndpoint: String(endpoint),
  capabilities: ["terminal", "browser"],
};

const preflight = (input: {
  readonly current?: string;
  readonly helper?: 0 | 1;
  readonly bridge?: 0 | 1;
  readonly ready?: 0 | 1;
  readonly unit?: "not-found" | "present";
  readonly generation?: string;
} = {}): string => {
  const current = input.current ?? "none";
  const installed = current !== "none";
  const ready = input.ready ?? 0;
  return [
    "LINUX_REMOTE_PREFLIGHT_V3",
    "disk=9999999999",
    `current=${current}`,
    `enabled=${ready}`,
    `active=${ready}`,
    "linger=1",
    `helper=${input.helper ?? 1}`,
    `bridge=${input.bridge ?? 1}`,
    `ready=${ready}`,
    `generation=${input.generation ?? (ready ? generation : "none")}`,
    "uid=1000",
    "gid=1000",
    "host=studio-box",
    "libc=2.39",
    `unit=${input.unit ?? (installed ? "present" : "not-found")}`,
  ].join(" ") + "\n";
};

const inventorySha256 = (): string => {
  const provisional = {
    version: "1.2.3",
    manifestSha256,
    debSha256,
    inventorySha256: "0".repeat(64),
  };
  return sha256(
    encodeLinuxReleaseBridgeInventory({
      candidate: provisional,
      totalBytes: bundleBytes,
      files,
    }),
  );
};

const credentialBinding = (): LinuxAdministratorCredentialBinding => ({
  hostId: host.id,
  endpoint,
  version: "1.2.3",
  manifestSha256,
  debSha256,
  inventorySha256: inventorySha256(),
});

const credential = (
  password = "correct horse battery staple",
): LinuxAdministratorCredential =>
  mintLinuxAdministratorCredential(password, credentialBinding());

const providerInput = (
  ssh: RemoteDeploymentProviderInput["ssh"],
  authorization?: LinuxAdministratorCredential,
): RemoteDeploymentProviderInput => ({
  ssh,
  target: {
    host: host as Extract<
      RemoteDeploymentProviderInput["target"]["host"],
      { readonly kind: "remote" }
    >,
    endpoint,
    platform: { platform: "linux", kernelName: "Linux" },
    progress: [],
  },
  stationConfiguration: {
    state: "applied",
    remoteHostId: host.id,
  },
  ...(authorization === undefined
    ? {}
    : {
        authorization: {
          kind: "linux-administrator-password" as const,
          credential: authorization,
        },
      }),
});

const makeProvider = (
  liveWorkAuthority: LinuxRemoteLiveWorkAuthority,
): RemoteDeploymentProvider =>
  makeLinuxRemoteDeploymentProvider({
    artifactAuthority: { resolve: async () => makeCandidate() },
    liveWorkAuthority,
  });

interface HeldRouteCut {
  readonly authority: LinuxRemoteLiveWorkAuthority;
  readonly acquire: ReturnType<typeof vi.fn>;
  readonly release: ReturnType<typeof vi.fn>;
  readonly isHeld: () => boolean;
}

const heldRouteCut = (): HeldRouteCut => {
  let held = false;
  const release = vi.fn(() => {
    held = false;
  });
  const acquire = vi.fn(() =>
    Effect.sync(() => {
      held = true;
      return {
        acquired: true as const,
        evidence: {
          activeTerminalSessions: 0 as const,
          observationId: "router-cut-test",
        },
        release: Effect.sync(release),
      };
    }),
  );
  return {
    authority: { acquire },
    acquire,
    release,
    isHeld: () => held,
  };
};

type AfterPassword =
  | "root-armed"
  | "cleanup"
  | "disconnect"
  | "refused"
  | "mismatch"
  | "malformed";
type AfterPrepare =
  | "root-ready"
  | "mismatch"
  | "malformed"
  | "refused";
type AfterCommit =
  | "ready"
  | "mismatch"
  | "malformed"
  | "refused"
  | "disconnect";

interface TranscriptPlan {
  readonly priorVersion?: string;
  readonly currentReady?: boolean;
  readonly recovery?: {
    readonly projectedVersion: string | null;
    readonly phase:
      | "fence-intent"
      | "prepared"
      | "dpkg-started"
      | "verified";
  };
  readonly auth?: "valid" | "mismatch" | "malformed";
  readonly afterPassword?: AfterPassword;
  readonly afterPrepare?: AfterPrepare;
  readonly afterCommit?: AfterCommit;
  readonly cleanup?: "valid" | "mismatch" | "malformed" | "missing";
  readonly transactExit?: "zero" | "nonzero";
  readonly failRegularWriteAt?: number;
  readonly extraAfterFinal?: boolean;
  readonly stderr?: string;
  readonly assertAuthorityHeld?: () => void;
}

interface TranscriptHarness {
  readonly ssh: RemoteDeploymentProviderInput["ssh"];
  readonly run: ReturnType<typeof vi.fn>;
  readonly transactCalls: ReadonlyArray<unknown>;
  readonly events: ReadonlyArray<string>;
  readonly regularWrites: ReadonlyArray<Buffer>;
  readonly sensitiveWrites: ReadonlyArray<Buffer>;
  readonly stage: () => LinuxReleaseBridgeStageRequest | undefined;
  readonly prepare: () =>
    | Extract<LinuxReleaseInstallerRequest, { readonly kind: "prepare" }>
    | undefined;
  readonly commit: () =>
    | Extract<LinuxReleaseInstallerRequest, { readonly kind: "commit" }>
    | undefined;
}

type OutputAction =
  | { readonly _tag: "line"; readonly value: string }
  | { readonly _tag: "end" };

const refusal = (
  transactionId: string | null,
): Extract<
  LinuxReleaseInstallerReceipt,
  { readonly ok: false; readonly state: "refused" }
> => ({
  schema: LINUX_RELEASE_INSTALLER_RECEIPT,
  ok: false,
  state: "refused",
  code: "protocol",
  transactionId,
  action: "send-a-new-bounded-frame",
});

const bridgeAuth = (
  stage: LinuxReleaseBridgeStageRequest,
): LinuxReleaseBridgeAuthArmed => ({
  schema: LINUX_RELEASE_BRIDGE_AUTH_PROTOCOL,
  kind: "AUTH_ARMED",
  transactionId: stage.transactionId,
  providerNonce: stage.providerNonce,
  bridgeNonce,
  target: stage.target,
  candidate: stage.candidate,
  totalBytes: stage.totalBytes,
});

const bridgeCleanup = (
  stage: LinuxReleaseBridgeStageRequest,
  reason: LinuxReleaseBridgeCleanupReason,
): LinuxReleaseBridgeStageCleared => ({
  schema: LINUX_RELEASE_BRIDGE_CLEAN_PROTOCOL,
  kind: "STAGE_CLEARED",
  transactionId: stage.transactionId,
  providerNonce: stage.providerNonce,
  bridgeNonce,
  target: stage.target,
  candidate: stage.candidate,
  totalBytes: stage.totalBytes,
  reason,
  cleanup: {
    files: "cleared",
    directory: "removed",
  },
});

const rootArmed = (
  stage: LinuxReleaseBridgeStageRequest,
): Extract<
  LinuxReleaseInstallerReceipt,
  { readonly ok: true; readonly state: "root-armed" }
> => ({
  schema: LINUX_RELEASE_INSTALLER_RECEIPT,
  ok: true,
  state: "root-armed",
  helperChallenge,
  target: {
    uid: stage.target.uid,
    gid: stage.target.gid,
    host: stage.target.host,
  },
  machineIdSha256,
  bootId,
});

const operationFor = (
  plan: TranscriptPlan,
): "install" | "adopt" =>
  (plan.recovery === undefined
    ? plan.priorVersion ?? null
    : plan.recovery.projectedVersion) === null
    ? "install"
    : (plan.recovery === undefined
        ? plan.priorVersion
        : plan.recovery.projectedVersion) === "1.2.3"
      ? "adopt"
      : "install";

const rootReady = (
  stage: LinuxReleaseBridgeStageRequest,
  request: Extract<
    LinuxReleaseInstallerRequest,
    { readonly kind: "prepare" }
  >,
  plan: TranscriptPlan,
): Extract<
  LinuxReleaseInstallerReceipt,
  { readonly ok: true; readonly state: "root-ready" }
> => {
  const operation = operationFor(plan);
  const projectedVersion = plan.recovery === undefined
    ? plan.priorVersion ?? null
    : plan.recovery.projectedVersion;
  return {
    schema: LINUX_RELEASE_INSTALLER_RECEIPT,
    ok: true,
    state: "root-ready",
    transactionId: request.transactionId,
    providerNonce: request.providerNonce,
    bridgeNonce: request.bridgeNonce,
    helperChallenge: request.helperChallenge,
    target: request.target,
    candidate: request.candidate,
    fence: {
      schema: LINUX_RELEASE_FENCE_PROTOCOL,
      fenceId,
      transactionId: request.transactionId,
      operation: operation === "install" ? "install" : "adopt",
      targetUid: request.target.uid,
      targetGid: request.target.gid,
      stationId: request.target.stationId,
      machineIdSha256,
      bootId,
      candidateDigest: request.candidate.inventorySha256,
    },
    machineIdSha256,
    bootId,
    operation,
    fromVersion: projectedVersion,
    currentVersion: plan.priorVersion ?? null,
    journalPredecessor: plan.recovery === undefined
      ? null
      : {
          transactionId: "2".repeat(32),
          operation: "install",
          phase: plan.recovery.phase,
        },
    maintenance: {
      activeTerminalSessions: 0,
      observationId: "tm_1111111111111111",
    },
    totalBytes: stage.totalBytes,
  };
};

const finalReady = (
  stage: LinuxReleaseBridgeStageRequest,
  prepared: Extract<
    LinuxReleaseInstallerReceipt,
    { readonly ok: true; readonly state: "root-ready" }
  >,
  request: Extract<
    LinuxReleaseInstallerRequest,
    { readonly kind: "commit" }
  >,
): Extract<
  LinuxReleaseInstallerReceipt,
  { readonly ok: true; readonly state: "ready" }
> => ({
  schema: LINUX_RELEASE_INSTALLER_RECEIPT,
  ok: true,
  state: "ready",
  transactionId: request.transactionId,
  providerNonce: request.providerNonce,
  bridgeNonce: request.bridgeNonce,
  helperChallenge: request.helperChallenge,
  fenceId: request.fenceId,
  inventorySha256: request.inventorySha256,
  operation: prepared.operation,
  fromVersion: prepared.fromVersion,
  toVersion: stage.candidate.version,
  manifestSha256: stage.candidate.manifestSha256,
  debSha256: stage.candidate.debSha256,
  sourceRevision,
  recoveredTransactionId: prepared.journalPredecessor?.transactionId ?? null,
  readiness: {
    state: "ready",
    generation,
    packageVersion: stage.candidate.version,
    receiptSha256: readinessReceiptSha256,
  },
});

const makeTranscriptHarness = (
  receipt: string,
  plan: TranscriptPlan = {},
): TranscriptHarness => {
  const output = Effect.runSync(Queue.unbounded<Uint8Array>());
  const events: string[] = [];
  const regularWrites: Buffer[] = [];
  const sensitiveWrites: Buffer[] = [];
  const transactCalls: unknown[] = [];
  let regularWriteCount = 0;
  let stagedBytes = Buffer.alloc(0);
  let stageHeaderBytes: number | undefined;
  let staged: LinuxReleaseBridgeStageRequest | undefined;
  let preparedRequest:
    | Extract<LinuxReleaseInstallerRequest, { readonly kind: "prepare" }>
    | undefined;
  let preparedReceipt:
    | Extract<
        LinuxReleaseInstallerReceipt,
        { readonly ok: true; readonly state: "root-ready" }
      >
    | undefined;
  let commitRequest:
    | Extract<LinuxReleaseInstallerRequest, { readonly kind: "commit" }>
    | undefined;
  let pendingCleanupReason: LinuxReleaseBridgeCleanupReason | undefined;
  let cleanupPublished = false;
  let outputEnded = false;

  const end = (): OutputAction => {
    outputEnded = true;
    return { _tag: "end" };
  };

  const publish = (
    actions: ReadonlyArray<OutputAction>,
  ): Effect.Effect<void, never> =>
    Effect.forEach(
      actions,
      (action) =>
        Queue.offer(
          output,
          action._tag === "line"
            ? Buffer.from(action.value, "utf8")
            : Buffer.alloc(0),
        ),
      { discard: true },
    );

  const authAction = (
    stage: LinuxReleaseBridgeStageRequest,
  ): OutputAction => {
    if (plan.auth === "malformed") {
      return { _tag: "line", value: '{"not":"an-auth-record"}\n' };
    }
    const auth = bridgeAuth(stage);
    return {
      _tag: "line",
      value: encodeLinuxReleaseBridgeAuthArmed(
        plan.auth === "mismatch"
          ? {
              ...auth,
              target: { ...auth.target, stationId: "other-station" },
            }
          : auth,
      ),
    };
  };

  const cleanupAction = (
    reason: LinuxReleaseBridgeCleanupReason,
  ): OutputAction | undefined => {
    if (plan.cleanup === "missing") return undefined;
    cleanupPublished = true;
    events.push("stage-cleared");
    if (plan.cleanup === "malformed") {
      return {
        _tag: "line",
        value: '{"kind":"STAGE_CLEARED"}\n',
      };
    }
    const cleanup = bridgeCleanup(staged!, reason);
    return {
      _tag: "line",
      value: encodeLinuxReleaseBridgeStageCleared(
        plan.cleanup === "mismatch"
          ? { ...cleanup, providerNonce: "9".repeat(32) }
          : cleanup,
      ),
    };
  };

  const handleStageWrite = (bytes: Buffer): ReadonlyArray<OutputAction> => {
    stagedBytes = Buffer.concat([stagedBytes, bytes]);
    if (stageHeaderBytes === undefined) {
      const newline = stagedBytes.indexOf(0x0a);
      if (newline < 0) return [];
      stageHeaderBytes = newline + 1;
      staged = decodeLinuxReleaseBridgeStageRequest(
        JSON.parse(stagedBytes.subarray(0, newline).toString("utf8")) as unknown,
      );
    }
    const bodyBytes = stagedBytes.byteLength - stageHeaderBytes;
    if (bodyBytes > staged!.totalBytes) {
      throw new Error("provider wrote bytes beyond its stage inventory");
    }
    if (bodyBytes !== staged!.totalBytes) return [];
    expect(stagedBytes.subarray(stageHeaderBytes)).toEqual(bundle);
    events.push("stage-complete", "auth-armed");
    return [authAction(staged!)];
  };

  const handleControlWrite = (
    bytes: Buffer,
  ): ReadonlyArray<OutputAction> => {
    const text = bytes.toString("utf8");
    const request = decodeLinuxReleaseInstallerRequest(
      JSON.parse(text) as unknown,
    );
    expect(encodeLinuxReleaseInstallerRequest(request)).toBe(text);
    if (request.kind === "prepare") {
      if (preparedRequest !== undefined) {
        throw new Error("provider wrote PREPARE more than once");
      }
      preparedRequest = request;
      events.push("prepare");
      if (plan.afterPrepare === "malformed") {
        return [{ _tag: "line", value: '{"state":"root-ready"}\n' }];
      }
      if (plan.afterPrepare === "refused") {
        events.push("refused");
        pendingCleanupReason = "installer-terminal";
        return [
          {
            _tag: "line",
            value: encodeLinuxReleaseInstallerReceipt(
              refusal(request.transactionId),
            ),
          },
        ];
      }
      const ready = rootReady(staged!, request, plan);
      preparedReceipt =
        plan.afterPrepare === "mismatch"
          ? { ...ready, providerNonce: "9".repeat(32) }
          : ready;
      events.push("root-ready");
      return [
        {
          _tag: "line",
          value: encodeLinuxReleaseInstallerReceipt(preparedReceipt),
        },
      ];
    }
    if (commitRequest !== undefined) {
      throw new Error("provider wrote COMMIT more than once");
    }
    if (preparedReceipt === undefined) {
      throw new Error("provider wrote COMMIT before ROOT_READY");
    }
    commitRequest = request;
    events.push("commit");
    if (plan.afterCommit === "disconnect") {
      return [end()];
    }
    if (plan.afterCommit === "malformed") {
      return [{ _tag: "line", value: '{"state":"ready"}\n' }];
    }
    if (plan.afterCommit === "refused") {
      events.push("refused");
      pendingCleanupReason = "installer-terminal";
      return [
        {
          _tag: "line",
          value: encodeLinuxReleaseInstallerReceipt(
            refusal(request.transactionId),
          ),
        },
      ];
    }
    const ready = finalReady(staged!, preparedReceipt, request);
    events.push("ready");
    pendingCleanupReason = "installer-terminal";
    return [
      {
        _tag: "line",
        value: encodeLinuxReleaseInstallerReceipt(
          plan.afterCommit === "mismatch"
            ? {
                ...ready,
                toVersion: "1.2.4",
                readiness: {
                  ...ready.readiness,
                  packageVersion: "1.2.4",
                },
              }
            : ready,
        ),
      },
    ];
  };

  const lease: SshLease = {
    write: (input) => {
      const bytes = Buffer.from(input);
      regularWrites.push(bytes);
      regularWriteCount += 1;
      plan.assertAuthorityHeld?.();
      if (plan.failRegularWriteAt === regularWriteCount) {
        return Effect.fail(
          new SshIoError({
            endpoint: String(endpoint),
            operation: "write",
            message: "injected partial stage disconnect",
          }),
        );
      }
      return Effect.sync(() =>
        staged === undefined ||
        stagedBytes.byteLength - (stageHeaderBytes ?? 0) < staged.totalBytes
          ? handleStageWrite(bytes)
          : handleControlWrite(bytes),
      ).pipe(Effect.flatMap(publish));
    },
    writeSensitive: (input) => {
      const bytes = Buffer.from(input);
      sensitiveWrites.push(bytes);
      plan.assertAuthorityHeld?.();
      events.push("password");
      return Effect.sync((): ReadonlyArray<OutputAction> => {
        if (staged === undefined) {
          throw new Error("provider wrote a password before AUTH_ARMED");
        }
        if (plan.afterPassword === "disconnect") {
          return [end()];
        }
        if (plan.afterPassword === "cleanup") {
          const cleanup = cleanupAction("authorization-failed");
          return cleanup === undefined ? [end()] : [cleanup];
        }
        if (plan.afterPassword === "refused") {
          events.push("refused");
          pendingCleanupReason = "installer-refused";
          return [
            {
              _tag: "line",
              value: encodeLinuxReleaseInstallerReceipt(
                refusal(null),
              ),
            },
          ];
        }
        if (plan.afterPassword === "malformed") {
          return [{ _tag: "line", value: '{"state":"root-armed"}\n' }];
        }
        const armed = rootArmed(staged);
        events.push("root-armed");
        return [
          {
            _tag: "line",
            value: encodeLinuxReleaseInstallerReceipt(
              plan.afterPassword === "mismatch"
                ? {
                    ...armed,
                    target: { ...armed.target, host: "other.example" },
                  }
                : armed,
            ),
          },
        ];
      }).pipe(Effect.flatMap(publish));
    },
    closeInput: Effect.suspend(() => {
      events.push("close-input");
      const actions: OutputAction[] = [];
      if (
        pendingCleanupReason !== undefined &&
        !cleanupPublished &&
        !outputEnded
      ) {
        const cleanup = cleanupAction(pendingCleanupReason);
        if (cleanup !== undefined) actions.push(cleanup);
      }
      if (plan.extraAfterFinal) {
        actions.push({ _tag: "line", value: "{}\n" });
      }
      if (!outputEnded) actions.push(end());
      return publish(actions);
    }),
    stdout: Stream.fromQueue(output).pipe(
      Stream.takeWhile((chunk) => chunk.byteLength !== 0),
    ),
    stderr:
      plan.stderr === undefined
        ? Stream.empty
        : Stream.make(Buffer.from(plan.stderr, "utf8")),
    exitCode: Effect.succeed(0),
    close: Effect.void,
  };

  const run = vi.fn(() =>
    Effect.succeed({
      stdout: receipt,
      stderr: "",
    }),
  );
  const transact: RemoteDeploymentProviderInput["ssh"]["transact"] = (
    program,
    use,
  ) => {
    transactCalls.push(program);
    return use(lease).pipe(
      Effect.flatMap((value) =>
        plan.transactExit === "nonzero"
          ? Effect.fail(
              new SshExitError({
                endpoint: String(endpoint),
                operation: "transaction",
                code: 1,
              }),
            )
          : Effect.succeed(value)
      ),
    );
  };
  const ssh = {
    run,
    transact,
  } as unknown as RemoteDeploymentProviderInput["ssh"];

  return {
    ssh,
    run,
    transactCalls,
    events,
    regularWrites,
    sensitiveWrites,
    stage: () => staged,
    prepare: () => preparedRequest,
    commit: () => commitRequest,
  };
};

describe("Linux Remote privileged deployment", () => {
  it("decodes only an exact V3 Ubuntu preflight receipt", () => {
    expect(decodeLinuxRemotePreflight(preflight())).toEqual({
      ok: true,
      availableBytes: 9_999_999_999,
      serviceEnabled: false,
      serviceActive: false,
      lingerEnabled: true,
      helperInstalled: true,
      bridgeInstalled: true,
      currentReady: false,
      uid: 1000,
      gid: 1000,
      host: "studio-box",
      libcVersion: "2.39",
      unitState: "not-found",
    });
    expect(
      decodeLinuxRemotePreflight(
        preflight({
          current: "1.2.3",
          ready: 1,
          unit: "present",
        }),
      ),
    ).toMatchObject({
      ok: true,
      installedVersion: "1.2.3",
      currentReady: true,
      generation,
      bridgeInstalled: true,
    });
    expect(
      decodeLinuxRemotePreflight(preflight({ ready: 1 })),
    ).toEqual({ ok: false, reason: "malformed" });
    expect(
      decodeLinuxRemotePreflight(
        "LINUX_REMOTE_PREFLIGHT_REFUSED_V3 reason=architecture\n",
      ),
    ).toEqual({ ok: false, reason: "architecture" });
    expect(
      decodeLinuxRemotePreflight(`${preflight()}extra\n`),
    ).toEqual({ ok: false, reason: "malformed" });
  });

  it("uses the fixed unprivileged bridge and proves both root-owned package executables", () => {
    expect(buildLinuxRemoteDeployCommand()).toEqual({
      executable: "/usr/libexec/vellum-release-bridge",
      args: [],
    });
    const script = buildLinuxRemotePreflightScript();
    expect(script).toContain("VERSION_ID");
    expect(script).toContain("/usr/libexec/vellum-release-bridge");
    expect(script).toContain("/usr/libexec/vellum-release-installer");
    expect(script).toContain('"0:0:755:1"');
    expect(script).toContain("PACKAGE_VERIFY_OK=1");
    expect(script).toContain('[ "$PACKAGE_VERIFY_OK" = 1 ]');
    expect(script).not.toMatch(/sudo\s+-n/u);
    expect(script).not.toContain("package-cache");
    expect(script).not.toContain("mktemp");
  });

  it("returns an exact authorization binding before route cut or transaction", async () => {
    const harness = makeTranscriptHarness(preflight());
    const route = heldRouteCut();
    const provider = makeProvider(route.authority);

    const receipt = await Effect.runPromise(
      provider.deploy(providerInput(harness.ssh)),
    );

    expect(receipt).toMatchObject({
      ok: false,
      code: "auth_required",
      disposition: "not-started",
      version: "1.2.3",
      authorizationRequest: {
        kind: "linux-administrator-password",
        hostId: "studio",
        endpoint: "studio-box",
        version: "1.2.3",
        manifestSha256,
        debSha256,
        inventorySha256: inventorySha256(),
      },
    });
    expect(harness.transactCalls).toHaveLength(0);
    expect(route.acquire).not.toHaveBeenCalled();
  });

  it("returns a typed validation failure for an authority-injected malformed inventory", async () => {
    const harness = makeTranscriptHarness(preflight());
    const route = heldRouteCut();
    const admitted = {
      ...makeAdmission(),
      files: Object.freeze([...files].reverse()),
    } as LinuxRemoteArtifactAdmission;
    const candidate = Object.freeze({
      ...makeCandidate(),
      authorize: vi.fn(() => admitted),
    });
    const provider = makeLinuxRemoteDeploymentProvider({
      artifactAuthority: { resolve: async () => candidate },
      liveWorkAuthority: route.authority,
    });

    const receipt = await Effect.runPromise(
      provider.deploy(providerInput(harness.ssh)),
    );

    expect(receipt).toMatchObject({
      ok: false,
      code: "validation",
      disposition: "not-started",
      version: "1.2.3",
    });
    expect(harness.transactCalls).toHaveLength(0);
    expect(route.acquire).not.toHaveBeenCalled();
  });

  it("keeps the host unchanged when live work denies the route cut", async () => {
    const harness = makeTranscriptHarness(preflight());
    const acquire = vi.fn(() =>
      Effect.succeed({
        acquired: false as const,
        reason: "active-terminal-sessions" as const,
        evidence: {
          activeTerminalSessions: 2,
          observationId: "active-work",
        },
      }),
    );
    const provider = makeProvider({ acquire });

    const receipt = await Effect.runPromise(
      provider.deploy(providerInput(harness.ssh, credential())),
    );

    expect(receipt).toMatchObject({
      ok: false,
      code: "conflict",
      disposition: "not-started",
      recoveryAction: {
        kind: "close-active-vellum-terminals",
        activeTerminalSessions: 2,
      },
    });
    expect(harness.transactCalls).toHaveLength(0);
    expect(harness.sensitiveWrites).toHaveLength(0);
  });

  it("installs over one exact password-gated duplex transaction under the route cut", async () => {
    const route = heldRouteCut();
    const harness = makeTranscriptHarness(preflight(), {
      assertAuthorityHeld: () => expect(route.isHeld()).toBe(true),
    });
    const provider = makeProvider(route.authority);

    const receipt = await Effect.runPromise(
      provider.deploy(
        providerInput(
          harness.ssh,
          credential("one transient password"),
        ),
      ),
    );

    expect(receipt).toMatchObject({
      ok: true,
      disposition: "ready",
      version: "1.2.3",
    });
    expect(harness.run).toHaveBeenCalledTimes(1);
    expect(harness.transactCalls).toHaveLength(1);
    expect(route.acquire).toHaveBeenCalledOnce();
    expect(route.release).toHaveBeenCalledOnce();
    expect(route.isHeld()).toBe(false);
    expect(harness.events).toEqual([
      "stage-complete",
      "auth-armed",
      "password",
      "root-armed",
      "prepare",
      "root-ready",
      "commit",
      "ready",
      "close-input",
      "stage-cleared",
    ]);
    expect(harness.sensitiveWrites).toEqual([
      Buffer.from("one transient password\n"),
    ]);
    expect(
      harness.regularWrites.some((bytes) =>
        bytes.includes(Buffer.from("one transient password")),
      ),
    ).toBe(false);

    const stage = harness.stage();
    const prepare = harness.prepare();
    const commit = harness.commit();
    expect(stage).toMatchObject({
      schema: "vellum/linux-release-bridge-stage/v1",
      kind: "stage",
      target: {
        uid: 1000,
        gid: 1000,
        host: "studio-box",
        stationId: "studio",
      },
      candidate: {
        version: "1.2.3",
        manifestSha256,
        debSha256,
        inventorySha256: inventorySha256(),
      },
      totalBytes: bundleBytes,
      files,
    });
    expect(prepare).toMatchObject({
      schema: LINUX_RELEASE_INSTALLER_PROTOCOL,
      kind: "prepare",
      transactionId: stage?.transactionId,
      providerNonce: stage?.providerNonce,
      bridgeNonce,
      helperChallenge,
      target: stage?.target,
      candidate: stage?.candidate,
      totalBytes: bundleBytes,
      files,
    });
    expect(commit).toEqual({
      schema: LINUX_RELEASE_INSTALLER_PROTOCOL,
      kind: "commit",
      transactionId: stage?.transactionId,
      providerNonce: stage?.providerNonce,
      bridgeNonce,
      helperChallenge,
      fenceId,
      inventorySha256: inventorySha256(),
    });
  });

  it("requires fresh authorization even for a same-version ready no-op", async () => {
    const current = preflight({
      current: "1.2.3",
      ready: 1,
      unit: "present",
    });
    const unauthorizedHarness = makeTranscriptHarness(current, {
      priorVersion: "1.2.3",
      currentReady: true,
    });
    const route = heldRouteCut();
    const provider = makeProvider(route.authority);

    const unauthorized = await Effect.runPromise(
      provider.deploy(providerInput(unauthorizedHarness.ssh)),
    );
    expect(unauthorized).toMatchObject({
      ok: false,
      code: "auth_required",
      disposition: "not-started",
    });
    expect(unauthorizedHarness.transactCalls).toHaveLength(0);

    const harness = makeTranscriptHarness(current, {
      priorVersion: "1.2.3",
      currentReady: true,
    });
    const ready = await Effect.runPromise(
      provider.deploy(providerInput(harness.ssh, credential())),
    );
    expect(ready).toMatchObject({
      ok: true,
      disposition: "ready",
      detail: expect.stringContaining("installed from the signed bundle"),
    });
    expect(harness.run).toHaveBeenCalledTimes(1);
    expect(harness.transactCalls).toHaveLength(1);
    expect(harness.events).toContain("commit");
  });

  it("commits an exact stale-journal recovery plan whose projected baseline differs from preflight", async () => {
    const current = preflight({
      current: "2.0.0",
      ready: 0,
      unit: "present",
    });
    const route = heldRouteCut();
    const harness = makeTranscriptHarness(current, {
      priorVersion: "2.0.0",
      currentReady: true,
      recovery: {
        projectedVersion: "1.2.3",
        phase: "dpkg-started",
      },
    });
    const provider = makeProvider(route.authority);

    const receipt = await Effect.runPromise(
      provider.deploy(providerInput(harness.ssh, credential())),
    );

    expect(receipt).toMatchObject({
      ok: true,
      disposition: "ready",
      version: "1.2.3",
      detail: expect.stringContaining("installed from the signed bundle"),
    });
    expect(harness.commit()).toBeDefined();
    expect(harness.events).toContain("stage-cleared");
  });

  it("does not retry a failed password or reuse its one-shot credential", async () => {
    const route = heldRouteCut();
    const harness = makeTranscriptHarness(preflight(), {
      afterPassword: "cleanup",
    });
    const provider = makeProvider(route.authority);
    const oneShot = credential("wrong password");
    const input = providerInput(harness.ssh, oneShot);

    const failed = await Effect.runPromise(provider.deploy(input));
    expect(failed).toMatchObject({
      ok: false,
      code: "auth_required",
      disposition: "not-started",
    });
    expect(harness.sensitiveWrites).toEqual([
      Buffer.from("wrong password\n"),
    ]);
    expect(harness.transactCalls).toHaveLength(1);

    const reused = await Effect.runPromise(provider.deploy(input));
    expect(reused).toMatchObject({
      ok: false,
      code: "auth_required",
      disposition: "not-started",
    });
    expect(harness.sensitiveWrites).toHaveLength(1);
    expect(harness.transactCalls).toHaveLength(1);
  });

  it("treats an unexplained disconnect after the password as indeterminate", async () => {
    const route = heldRouteCut();
    const harness = makeTranscriptHarness(preflight(), {
      afterPassword: "disconnect",
    });
    const provider = makeProvider(route.authority);

    const receipt = await Effect.runPromise(
      provider.deploy(providerInput(harness.ssh, credential("wrong password"))),
    );

    expect(receipt).toMatchObject({
      ok: false,
      code: "conflict",
      disposition: "indeterminate",
      recoveryAction: {
        kind: "repair-linux-release-transaction",
      },
    });
    expect(harness.sensitiveWrites).toHaveLength(1);
  });

  it("retains an indeterminate repair fence when the stream ends after COMMIT", async () => {
    const route = heldRouteCut();
    const harness = makeTranscriptHarness(preflight(), {
      afterCommit: "disconnect",
    });
    const provider = makeProvider(route.authority);

    const receipt = await Effect.runPromise(
      provider.deploy(providerInput(harness.ssh, credential())),
    );

    expect(receipt).toMatchObject({
      ok: false,
      code: "conflict",
      disposition: "indeterminate",
      recoveryAction: {
        kind: "repair-linux-release-transaction",
      },
    });
    expect(harness.commit()).toBeDefined();
    expect(harness.sensitiveWrites).toHaveLength(1);
    expect(route.release).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "bridge binding mismatch",
      plan: { auth: "mismatch" } satisfies TranscriptPlan,
      disposition: "indeterminate",
      sensitiveWrites: 0,
    },
    {
      name: "malformed bridge record",
      plan: { auth: "malformed" } satisfies TranscriptPlan,
      disposition: "indeterminate",
      sensitiveWrites: 0,
    },
    {
      name: "root authorization target mismatch",
      plan: { afterPassword: "mismatch" } satisfies TranscriptPlan,
      disposition: "indeterminate",
      sensitiveWrites: 1,
    },
    {
      name: "malformed root authorization record",
      plan: { afterPassword: "malformed" } satisfies TranscriptPlan,
      disposition: "indeterminate",
      sensitiveWrites: 1,
    },
    {
      name: "root-ready binding mismatch",
      plan: { afterPrepare: "mismatch" } satisfies TranscriptPlan,
      disposition: "indeterminate",
      sensitiveWrites: 1,
    },
    {
      name: "malformed root-ready record",
      plan: { afterPrepare: "malformed" } satisfies TranscriptPlan,
      disposition: "indeterminate",
      sensitiveWrites: 1,
    },
    {
      name: "final binding mismatch",
      plan: { afterCommit: "mismatch" } satisfies TranscriptPlan,
      disposition: "indeterminate",
      sensitiveWrites: 1,
    },
    {
      name: "malformed final record",
      plan: { afterCommit: "malformed" } satisfies TranscriptPlan,
      disposition: "indeterminate",
      sensitiveWrites: 1,
    },
    {
      name: "extra final record",
      plan: { extraAfterFinal: true } satisfies TranscriptPlan,
      disposition: "indeterminate",
      sensitiveWrites: 1,
    },
    {
      name: "stderr diagnostics",
      plan: { stderr: "unexpected diagnostic\n" } satisfies TranscriptPlan,
      disposition: "indeterminate",
      sensitiveWrites: 1,
    },
  ])(
    "fails closed on $name",
    async ({ plan, disposition, sensitiveWrites }) => {
      const route = heldRouteCut();
      const harness = makeTranscriptHarness(preflight(), plan);
      const provider = makeProvider(route.authority);

      const receipt = await Effect.runPromise(
        provider.deploy(providerInput(harness.ssh, credential())),
      );

      expect(receipt).toMatchObject({
        ok: false,
        disposition,
      });
      expect(harness.sensitiveWrites).toHaveLength(sensitiveWrites);
      expect(harness.transactCalls).toHaveLength(1);
      expect(route.release).toHaveBeenCalledOnce();
    },
  );

  it.each([
    {
      name: "missing cleanup",
      plan: {
        afterPassword: "cleanup",
        cleanup: "missing",
      } satisfies TranscriptPlan,
    },
    {
      name: "mismatched cleanup",
      plan: {
        afterPassword: "cleanup",
        cleanup: "mismatch",
      } satisfies TranscriptPlan,
    },
    {
      name: "malformed cleanup",
      plan: {
        afterPassword: "cleanup",
        cleanup: "malformed",
      } satisfies TranscriptPlan,
    },
    {
      name: "nonzero bridge exit after cleanup",
      plan: {
        afterPassword: "cleanup",
        transactExit: "nonzero",
      } satisfies TranscriptPlan,
    },
    {
      name: "pre-commit refusal without cleanup",
      plan: {
        afterPrepare: "refused",
        cleanup: "missing",
      } satisfies TranscriptPlan,
    },
    {
      name: "partial stage disconnect",
      plan: {
        failRegularWriteAt: 2,
      } satisfies TranscriptPlan,
    },
  ])(
    "requires completed exact bridge cleanup for $name",
    async ({ plan }) => {
      const route = heldRouteCut();
      const harness = makeTranscriptHarness(preflight(), plan);
      const provider = makeProvider(route.authority);

      const receipt = await Effect.runPromise(
        provider.deploy(providerInput(harness.ssh, credential())),
      );

      expect(receipt).toMatchObject({
        ok: false,
        code: "conflict",
        disposition: "indeterminate",
        recoveryAction: {
          kind: "repair-linux-release-transaction",
        },
      });
      expect(harness.transactCalls).toHaveLength(1);
      expect(route.release).toHaveBeenCalledOnce();
    },
  );

  it("treats a generic post-COMMIT refusal as indeterminate even with stage cleanup", async () => {
    const route = heldRouteCut();
    const harness = makeTranscriptHarness(preflight(), {
      afterCommit: "refused",
    });
    const provider = makeProvider(route.authority);

    const receipt = await Effect.runPromise(
      provider.deploy(providerInput(harness.ssh, credential())),
    );

    expect(receipt).toMatchObject({
      ok: false,
      code: "conflict",
      disposition: "indeterminate",
      recoveryAction: {
        kind: "repair-linux-release-transaction",
      },
    });
    expect(harness.commit()).toBeDefined();
    expect(harness.events).toContain("stage-cleared");
  });

  it("distinguishes a pre-COMMIT refusal from an indeterminate post-COMMIT refusal", async () => {
    const provider = makeProvider(heldRouteCut().authority);
    const refusedHarness = makeTranscriptHarness(preflight(), {
      afterPrepare: "refused",
    });
    const refused = await Effect.runPromise(
      provider.deploy(
        providerInput(refusedHarness.ssh, credential()),
      ),
    );
    expect(refused).toMatchObject({
      ok: false,
      code: "validation",
      disposition: "not-started",
    });
    expect(refusedHarness.commit()).toBeUndefined();

    const postCommitHarness = makeTranscriptHarness(preflight(), {
      afterCommit: "refused",
    });
    const postCommit = await Effect.runPromise(
      provider.deploy(
        providerInput(postCommitHarness.ssh, credential()),
      ),
    );
    expect(postCommit).toMatchObject({
      ok: false,
      code: "conflict",
      disposition: "indeterminate",
    });
    expect(postCommitHarness.commit()).toBeDefined();
  });

  it("requires exact package custody before asking for authorization", async () => {
    const harness = makeTranscriptHarness(
      preflight({ helper: 0, bridge: 0 }),
    );
    const route = heldRouteCut();
    const provider = makeProvider(route.authority);

    const receipt = await Effect.runPromise(
      provider.deploy(providerInput(harness.ssh)),
    );

    expect(receipt).toMatchObject({
      ok: false,
      code: "auth_required",
      disposition: "not-started",
      recoveryAction: {
        kind: "bootstrap-linux-release-installer",
      },
    });
    expect(receipt.authorizationRequest).toBeUndefined();
    expect(harness.transactCalls).toHaveLength(0);
    expect(route.acquire).not.toHaveBeenCalled();
  });
});
