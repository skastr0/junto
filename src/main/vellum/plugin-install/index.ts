/**
 * Factory plugin install — apply frozen precompiled payloads (no runtime
 * packager / no Bun for end users). Regenerate payloads with:
 *   bun run plugin:precompile
 *
 * Apply DesiredFile[] locally or over SshTransport.
 */

export type {
  ApplyOperation,
  ApplyOperationType,
  ApplyReceipt,
  DesiredFile,
  DesiredFileWire,
} from "./desired";
export {
  DesiredFileSchema,
  decodeDesiredFile,
  encodeDesiredFile,
} from "./desired";

export {
  compilePluginPackage,
  PackageCompileError,
  type CompilePluginPackageOptions,
} from "./package";

export {
  applyDesiredFilesLocal,
  LocalApplyError,
  type ApplyLocalOptions,
  type LocalApplyErrorUnion,
} from "./apply-local";

export {
  applyDesiredFilesRemote,
  compilePluginDesiredFileWrite,
  RemoteApplyError,
  type ApplyRemoteOptions,
  type RemoteApplyErrorUnion,
} from "./apply-remote";

export {
  installVellumPlugin,
  desiredFilesFromPackage,
  InstallError,
  type InstallReceipt,
  type InstallVellumPluginOptions,
} from "./install";

export {
  admitDesiredTargetPath,
  admitRemoteAbsPath,
  contentHash,
  expandUserPath,
  PathSafetyError,
} from "./paths";
