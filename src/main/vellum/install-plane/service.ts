/**
 * Install plane — pristine Effect service for fleet install capabilities.
 *
 * Domain: effective gates, factory plugin install (packager), route-token admin.
 * Glue (IPC) stays in hosts/ipc — this module owns orchestration invariants.
 *
 * PCMI: capabilities formula + install/token ops are the component; IPC is glue.
 */
import { Context, Effect, Layer, Schema } from "effect";
import type {
  HostsInstallCapabilitiesResult,
  HostsInstallPluginInput,
  HostsInstallPluginResult,
  HostsInstallPluginTarget,
  RouteTokenIdInput,
  RouteTokenListResult,
  RouteTokenMintInput,
  RouteTokenMintResult,
  RouteTokenRevokeResult,
} from "@shared/ipc";
import {
  computeInstallCapabilities,
  type HostsInstallCapabilities,
} from "@shared/install-capabilities";
import {
  NOT_COMMAND_CENTER_DETAIL,
  PLUGIN_INSTALL_DISABLED_DETAIL,
  RELEASE_CAPABILITIES,
  REMOTE_INSTALLS_OPERATOR_DISABLED_DETAIL,
} from "@shared/release-capabilities";
import { parseSshEndpoint } from "../ssh/domain";
import { homeDirectoryLookup } from "../ssh/program";
import { decodeRemoteHomeDirectoryOutput } from "../hosts/remote-home";
import { HostsService } from "../hosts/service";
import { SshTransport } from "../ssh/service";
import { SettingsService } from "../settings/service";
import { CanvasesService } from "../canvases";
import {
  installVellumPlugin,
  type InstallReceipt,
} from "../plugin-install/install";
import { harnessApplyRoot } from "../plugin-install/harness-homes";
import {
  isFleetPluginTarget,
  type FleetPluginTarget,
} from "../plugin-install/harness-targets";
import { resolveVellumPluginPath } from "../plugin-install/plugin-path";
import { proveLiveSeat } from "../work/live-seat";
import {
  listRouteTokens,
  mintRouteToken,
  revokeRouteToken,
  rotateRouteToken,
  RouteTokenError,
} from "../work/route-tokens";

export class InstallPlaneError extends Schema.TaggedError<InstallPlaneError>()(
  "InstallPlaneError",
  {
    code: Schema.Literal("validation", "not_found", "io", "forbidden"),
    message: Schema.String,
  },
) {}

const asInstallError = (error: unknown): InstallPlaneError => {
  if (error instanceof InstallPlaneError) return error;
  if (error instanceof RouteTokenError) {
    return new InstallPlaneError({
      code:
        error.code === "not_found"
          ? "not_found"
          : error.code === "invalid"
            ? "validation"
            : "io",
      message: error.message,
    });
  }
  return new InstallPlaneError({
    code: "io",
    message: error instanceof Error ? error.message : String(error),
  });
};

const PluginInput = Schema.Struct({
  mode: Schema.Literal("local", "remote"),
  hostId: Schema.optionalWith(Schema.String, { exact: true }),
  targets: Schema.Array(
    Schema.Literal("claude-code", "codex-cli", "grok", "hermes"),
  ).pipe(Schema.minItems(1), Schema.maxItems(8)),
  scope: Schema.optionalWith(Schema.Literal("global", "project"), {
    exact: true,
  }),
});

const MintInput = Schema.Struct({
  canvasName: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
  nodeId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
  kind: Schema.Literal("agent", "terminal"),
  agentKey: Schema.optionalWith(Schema.String, { exact: true }),
  bindingId: Schema.optionalWith(Schema.String, { exact: true }),
});

const IdInput = Schema.Struct({
  id: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64)),
});

export class InstallPlane extends Context.Tag("@vellum/InstallPlane")<
  InstallPlane,
  {
    readonly capabilities: Effect.Effect<HostsInstallCapabilitiesResult>;
    readonly installPlugin: (
      input: unknown,
    ) => Effect.Effect<HostsInstallPluginResult>;
    readonly listRouteTokens: Effect.Effect<RouteTokenListResult>;
    readonly mintRouteToken: (
      input: unknown,
    ) => Effect.Effect<RouteTokenMintResult>;
    readonly rotateRouteToken: (
      input: unknown,
    ) => Effect.Effect<RouteTokenMintResult>;
    readonly revokeRouteToken: (
      input: unknown,
    ) => Effect.Effect<RouteTokenRevokeResult>;
  }
>() {}

type SettingsSvc = Context.Tag.Service<typeof SettingsService>;
type HostsSvc = Context.Tag.Service<typeof HostsService>;
type SshSvc = Context.Tag.Service<typeof SshTransport>;

const readCapabilities = (
  settings: SettingsSvc,
): Effect.Effect<HostsInstallCapabilities, InstallPlaneError> =>
  settings.get.pipe(
    Effect.mapError(
      (e) =>
        new InstallPlaneError({
          code: "io",
          message: e.message,
        }),
    ),
    Effect.map((doc) =>
      computeInstallCapabilities({
        stationRole: doc.station.role,
        remoteManagedInstalls: doc.fleet.remoteManagedInstalls,
        release: RELEASE_CAPABILITIES,
        platform: process.platform,
      }),
    ),
  );

export const InstallPlaneLive = Layer.effect(
  InstallPlane,
  Effect.gen(function* () {
    const settings = yield* SettingsService;
    const hosts = yield* HostsService;
    const ssh = yield* SshTransport;
    const canvases = yield* CanvasesService;

    const capabilities: Effect.Effect<HostsInstallCapabilitiesResult> =
      readCapabilities(settings).pipe(
        Effect.catchTag("InstallPlaneError", (error) =>
          Effect.succeed({
            ok: false as const,
            code: error.code,
            message: error.message,
          }),
        ),
      );

    const installPlugin = (
      input: unknown,
    ): Effect.Effect<HostsInstallPluginResult> =>
      Effect.gen(function* () {
        const decoded = Schema.decodeUnknownEither(PluginInput)(input);
        if (decoded._tag === "Left") {
          return {
            ok: false,
            detail: "invalid install plugin request",
            code: "validation",
            message: "invalid install plugin request",
          } satisfies HostsInstallPluginResult;
        }
        const body = decoded.right as HostsInstallPluginInput;
        for (const target of body.targets) {
          if (!isFleetPluginTarget(target)) {
            return {
              ok: false,
              detail: `unsupported harness target: ${target}`,
              code: "validation",
              message: `unsupported harness target: ${target}`,
            } satisfies HostsInstallPluginResult;
          }
        }

        const caps = yield* readCapabilities(settings);
        if (body.mode === "remote") {
          if (!caps.effective.installPluginRemote) {
            return {
              ok: false,
              detail:
                caps.detail.installPluginRemote ??
                REMOTE_INSTALLS_OPERATOR_DISABLED_DETAIL,
              code: "forbidden",
              message:
                caps.detail.installPluginRemote ??
                REMOTE_INSTALLS_OPERATOR_DISABLED_DETAIL,
            } satisfies HostsInstallPluginResult;
          }
        } else if (!caps.effective.installPluginLocal) {
          return {
            ok: false,
            detail:
              caps.detail.installPluginLocal ?? PLUGIN_INSTALL_DISABLED_DETAIL,
            code: "forbidden",
            message:
              caps.detail.installPluginLocal ?? PLUGIN_INSTALL_DISABLED_DETAIL,
          } satisfies HostsInstallPluginResult;
        }

        const pluginPath = resolveVellumPluginPath();
        if (pluginPath === undefined) {
          return {
            ok: false,
            detail:
              "packages/vellum-plugin not found (set VELLUM_PLUGIN_PATH or run from repo)",
            code: "not_found",
            message:
              "packages/vellum-plugin not found (set VELLUM_PLUGIN_PATH or run from repo)",
          } satisfies HostsInstallPluginResult;
        }

        const results: Array<{
          target: string;
          packageId: string;
          applied: number;
          skipped: number;
          regionsSkipped?: number;
        }> = [];

        const pushReceipt = (
          target: string,
          receipt: InstallReceipt,
        ): void => {
          results.push({
            target,
            packageId: receipt.packageId,
            applied: receipt.applied,
            skipped: receipt.skipped,
            ...(receipt.regionsSkipped > 0
              ? { regionsSkipped: receipt.regionsSkipped }
              : {}),
          });
        };

        if (body.mode === "local") {
          const home = process.env.HOME?.trim();
          if (!home) {
            return {
              ok: false,
              detail: "local install requires HOME for harness applyRoot",
              code: "validation",
              message: "local install requires HOME for harness applyRoot",
            } satisfies HostsInstallPluginResult;
          }
          for (const target of body.targets as ReadonlyArray<HostsInstallPluginTarget>) {
            const applyRoot = harnessApplyRoot(
              home,
              target as FleetPluginTarget,
            );
            const receipt = yield* installVellumPlugin({
              pluginPath,
              target,
              mode: "local",
              scope: body.scope ?? "global",
              applyRoot,
            }).pipe(
              Effect.mapError(
                (error) =>
                  new InstallPlaneError({
                    code: "io",
                    message: error.message,
                  }),
              ),
            );
            pushReceipt(target, receipt);
          }
          const regionWarn = results.some((r) => (r.regionsSkipped ?? 0) > 0);
          return {
            ok: true,
            detail: regionWarn
              ? `installed ${results.length} harness target(s) locally under harness homes (some config regions not applied — incomplete)`
              : `installed ${results.length} harness target(s) locally under harness homes`,
            results,
          } satisfies HostsInstallPluginResult;
        }

        const hostId = body.hostId?.trim();
        if (!hostId) {
          return {
            ok: false,
            detail: "remote install requires hostId",
            code: "validation",
            message: "remote install requires hostId",
          } satisfies HostsInstallPluginResult;
        }

        const host = yield* hosts.get(hostId).pipe(
          Effect.mapError(
            (error) =>
              new InstallPlaneError({
                code: error.code === "not_found" ? "not_found" : "io",
                message: error.message,
              }),
          ),
        );
        if (!host || host.kind !== "remote" || !host.endpoint) {
          return {
            ok: false,
            detail: `host "${hostId}" is not a remote with an SSH endpoint`,
            code: "not_found",
            message: `host "${hostId}" is not a remote with an SSH endpoint`,
          } satisfies HostsInstallPluginResult;
        }

        const endpoint = yield* parseSshEndpoint(host.endpoint).pipe(
          Effect.mapError(
            (error) =>
              new InstallPlaneError({
                code: "validation",
                message: error.message,
              }),
          ),
        );

        const homeResult = yield* ssh.run(homeDirectoryLookup(endpoint)).pipe(
          Effect.mapError(
            (error) =>
              new InstallPlaneError({
                code: "io",
                message: `remote home lookup failed: ${error._tag}`,
              }),
          ),
        );
        const stdout = homeResult.stdout.endsWith("\n")
          ? homeResult.stdout
          : `${homeResult.stdout}\n`;
        const applyRoot = decodeRemoteHomeDirectoryOutput(stdout);
        if (applyRoot === null) {
          return {
            ok: false,
            detail: "remote home directory lookup returned an unsafe path",
            code: "io",
            message: "remote home directory lookup returned an unsafe path",
          } satisfies HostsInstallPluginResult;
        }

        for (const target of body.targets as ReadonlyArray<HostsInstallPluginTarget>) {
          const targetRoot = harnessApplyRoot(
            applyRoot,
            target as FleetPluginTarget,
          );
          const receipt: InstallReceipt = yield* installVellumPlugin({
            pluginPath,
            target,
            mode: "remote",
            endpoint,
            scope: body.scope ?? "global",
            applyRoot: targetRoot,
          }).pipe(
            Effect.provideService(SshTransport, ssh),
            Effect.mapError(
              (error) =>
                new InstallPlaneError({
                  code: "io",
                  message: error.message,
                }),
            ),
          );
          pushReceipt(target, receipt);
        }

        const regionWarn = results.some((r) => (r.regionsSkipped ?? 0) > 0);
        return {
          ok: true,
          detail: regionWarn
            ? `installed ${results.length} harness target(s) on ${host.label} under harness homes (some config regions not applied — incomplete)`
            : `installed ${results.length} harness target(s) on ${host.label} under harness homes (home=${applyRoot})`,
          results,
        } satisfies HostsInstallPluginResult;
      }).pipe(
        Effect.catchTag("InstallPlaneError", (error) =>
          Effect.succeed({
            ok: false,
            detail: error.message,
            code: error.code,
            message: error.message,
          } satisfies HostsInstallPluginResult),
        ),
      );

    const listTokens: Effect.Effect<RouteTokenListResult> = Effect.gen(
      function* () {
        const caps = yield* readCapabilities(settings);
        if (!caps.effective.routeTokenAdmin) {
          return {
            ok: false,
            code: "forbidden",
            message:
              caps.detail.routeTokenAdmin ?? NOT_COMMAND_CENTER_DETAIL,
          } satisfies RouteTokenListResult;
        }
        const tokens = listRouteTokens();
        return {
          ok: true,
          tokens: tokens.map((t) => ({
            id: t.id,
            principal: t.principal,
            createdAt: t.createdAt,
            ...(t.revokedAt !== undefined ? { revokedAt: t.revokedAt } : {}),
          })),
        } satisfies RouteTokenListResult;
      },
    ).pipe(
      Effect.catchTag("InstallPlaneError", (error) =>
        Effect.succeed({
          ok: false,
          code: error.code,
          message: error.message,
        } satisfies RouteTokenListResult),
      ),
    );

    const mint = (input: unknown): Effect.Effect<RouteTokenMintResult> =>
      Effect.gen(function* () {
        const caps = yield* readCapabilities(settings);
        if (!caps.effective.routeTokenAdmin) {
          return {
            ok: false,
            code: "forbidden",
            message: caps.detail.routeTokenAdmin ?? NOT_COMMAND_CENTER_DETAIL,
          } satisfies RouteTokenMintResult;
        }
        const decoded = Schema.decodeUnknownEither(MintInput)(input);
        if (decoded._tag === "Left") {
          return {
            ok: false,
            code: "validation",
            message: "invalid route-token mint request",
          } satisfies RouteTokenMintResult;
        }
        const liveDocs = yield* canvases.liveDocuments().pipe(
          Effect.mapError(
            (error) =>
              new InstallPlaneError({
                code: "io",
                message:
                  error instanceof Error
                    ? error.message
                    : "live canvas authority unavailable",
              }),
          ),
        );
        const seat = proveLiveSeat(liveDocs, decoded.right);
        if (!seat.ok) {
          return {
            ok: false,
            code: seat.code === "invalid" ? "validation" : "not_found",
            message: seat.message,
          } satisfies RouteTokenMintResult;
        }
        try {
          const minted = mintRouteToken(seat.principal);
          return {
            ok: true,
            id: minted.id,
            token: minted.token,
          } satisfies RouteTokenMintResult;
        } catch (error) {
          const mapped = asInstallError(error);
          return {
            ok: false,
            code: mapped.code,
            message: mapped.message,
          } satisfies RouteTokenMintResult;
        }
      }).pipe(
        Effect.catchTag("InstallPlaneError", (error) =>
          Effect.succeed({
            ok: false,
            code: error.code,
            message: error.message,
          } satisfies RouteTokenMintResult),
        ),
      );

    const rotate = (input: unknown): Effect.Effect<RouteTokenMintResult> =>
      Effect.gen(function* () {
        const caps = yield* readCapabilities(settings);
        if (!caps.effective.routeTokenAdmin) {
          return {
            ok: false,
            code: "forbidden",
            message: caps.detail.routeTokenAdmin ?? NOT_COMMAND_CENTER_DETAIL,
          } satisfies RouteTokenMintResult;
        }
        const decoded = Schema.decodeUnknownEither(IdInput)(input);
        if (decoded._tag === "Left") {
          return {
            ok: false,
            code: "validation",
            message: "invalid route-token id",
          } satisfies RouteTokenMintResult;
        }
        try {
          const minted = rotateRouteToken(
            (decoded.right as RouteTokenIdInput).id,
          );
          return {
            ok: true,
            id: minted.id,
            token: minted.token,
          } satisfies RouteTokenMintResult;
        } catch (error) {
          const mapped = asInstallError(error);
          return {
            ok: false,
            code: mapped.code,
            message: mapped.message,
          } satisfies RouteTokenMintResult;
        }
      }).pipe(
        Effect.catchTag("InstallPlaneError", (error) =>
          Effect.succeed({
            ok: false,
            code: error.code,
            message: error.message,
          } satisfies RouteTokenMintResult),
        ),
      );

    const revoke = (input: unknown): Effect.Effect<RouteTokenRevokeResult> =>
      Effect.gen(function* () {
        const caps = yield* readCapabilities(settings);
        if (!caps.effective.routeTokenAdmin) {
          return {
            ok: false,
            code: "forbidden",
            message: caps.detail.routeTokenAdmin ?? NOT_COMMAND_CENTER_DETAIL,
          } satisfies RouteTokenRevokeResult;
        }
        const decoded = Schema.decodeUnknownEither(IdInput)(input);
        if (decoded._tag === "Left") {
          return {
            ok: false,
            code: "validation",
            message: "invalid route-token id",
          } satisfies RouteTokenRevokeResult;
        }
        try {
          revokeRouteToken((decoded.right as RouteTokenIdInput).id);
          return { ok: true } satisfies RouteTokenRevokeResult;
        } catch (error) {
          const mapped = asInstallError(error);
          return {
            ok: false,
            code: mapped.code,
            message: mapped.message,
          } satisfies RouteTokenRevokeResult;
        }
      }).pipe(
        Effect.catchTag("InstallPlaneError", (error) =>
          Effect.succeed({
            ok: false,
            code: error.code,
            message: error.message,
          } satisfies RouteTokenRevokeResult),
        ),
      );

    return InstallPlane.of({
      capabilities,
      installPlugin,
      listRouteTokens: listTokens,
      mintRouteToken: mint,
      rotateRouteToken: rotate,
      revokeRouteToken: revoke,
    });
  }),
);
