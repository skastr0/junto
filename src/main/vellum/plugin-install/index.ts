/**
 * Packager-embed plugin install — compile via `@skastr0/prism-packager`,
 * apply DesiredFile[] locally or over SshTransport.
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
