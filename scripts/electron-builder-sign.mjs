import { readFile, realpath } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signAsync } from "@electron/osx-sign";
import { resolveMacSigningConfig } from "./mac-signing-config.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(SCRIPT_DIR);
const RUNTIME_POLICY_PATH = path.join(SCRIPT_DIR, "macos-runtime-policy.json");
const PACKAGE_POLICY_PATH = path.join(SCRIPT_DIR, "package-security-policy.json");
const JIT_ENTITLEMENTS_PATH = path.join(REPO_ROOT, "build", "entitlements.mac.plist");
const EMPTY_ENTITLEMENTS_PATH = path.join(
  REPO_ROOT,
  "build",
  "entitlements.mac.inherit.plist",
);
const SIGN_RETRY_DELAYS_MS = [5_000, 10_000, 15_000];

const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const loadJson = async (filePath) => JSON.parse(await readFile(filePath, "utf8"));

const validatePolicies = (runtimePolicy, packagePolicy) => {
  if (
    !isRecord(runtimePolicy) ||
    runtimePolicy.version !== 1 ||
    !isRecord(runtimePolicy.profiles) ||
    !Array.isArray(runtimePolicy.machO) ||
    !isRecord(packagePolicy) ||
    typeof packagePolicy.productName !== "string"
  ) {
    throw new Error("invalid Junto macOS signing policy");
  }
  if (
    Object.keys(runtimePolicy.profiles).sort().join(",") !== "jit,none" ||
    Object.keys(runtimePolicy.profiles.none).length !== 0 ||
    JSON.stringify(runtimePolicy.profiles.jit) !==
      JSON.stringify({ "com.apple.security.cs.allow-jit": true, "com.apple.security.device.audio-input": true })
  ) {
    throw new Error("macOS signing policy must expose only the none and JIT profiles");
  }

  const seen = new Set();
  for (const entry of runtimePolicy.machO) {
    if (
      !isRecord(entry) ||
      typeof entry.path !== "string" ||
      typeof entry.identifier !== "string" ||
      (entry.profile !== "none" && entry.profile !== "jit") ||
      path.isAbsolute(entry.path) ||
      entry.path.split("/").includes("..") ||
      !entry.path.startsWith("Contents/") ||
      seen.has(entry.path)
    ) {
      throw new Error("macOS signing policy contains an invalid or duplicate Mach-O entry");
    }
    seen.add(entry.path);
  }
  // Inventory grows with native deps (e.g. node-pty prebuilds) and packaged CLIs.
  // Keep in lockstep with scripts/macos-runtime-policy.json machO[] — currently 24 objects.
  if (seen.size !== 24) {
    throw new Error(`macOS signing policy must name exactly 24 Mach-O objects, got ${seen.size}`);
  }
};

const helperBundleForExecutable = (relativePath) => {
  const suffix = "/Contents/MacOS/";
  const index = relativePath.indexOf(suffix);
  if (index < 0 || !relativePath.slice(0, index).endsWith(".app")) return undefined;
  return relativePath.slice(0, index);
};

export const signingProfileForPath = (appPath, filePath, runtimePolicy) => {
  const appRoot = path.resolve(appPath);
  const resolved = path.resolve(filePath);
  const relative = path.relative(appRoot, resolved).split(path.sep).join("/");
  if (relative === "") return "jit";
  if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) {
    throw new Error("electron-osx-sign attempted to sign outside the app bundle");
  }

  const jitTargets = new Set();
  for (const entry of runtimePolicy.machO) {
    if (entry.profile !== "jit") continue;
    jitTargets.add(entry.path);
    const bundle = helperBundleForExecutable(entry.path);
    if (bundle !== undefined) jitTargets.add(bundle);
  }
  return jitTargets.has(relative) ? "jit" : "none";
};

const signWithRetries = async (options) => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await signAsync(options);
      return;
    } catch (error) {
      const delayMs = SIGN_RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
};

export default async function signVellumApp(options) {
  const [runtimePolicy, packagePolicy] = await Promise.all([
    loadJson(RUNTIME_POLICY_PATH),
    loadJson(PACKAGE_POLICY_PATH),
  ]);
  validatePolicies(runtimePolicy, packagePolicy);

  if (options.platform !== "darwin") {
    throw new Error(`Signing supports darwin only, got ${String(options.platform)}`);
  }
  const appPath = await realpath(options.app);
  if (path.basename(appPath) !== `${packagePolicy.productName}.app`) {
    throw new Error(`unexpected macOS app bundle ${path.basename(appPath)}`);
  }
  const inheritedOptionsForFile = options.optionsForFile;

  await signWithRetries({
    ...options,
    app: appPath,
    identity: resolveMacSigningConfig().signingIdentity,
    identityValidation: true,
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    optionsForFile: (filePath) => {
      const canonicalFilePath = realpathSync(filePath);
      const relativeCanonical = path.relative(appPath, canonicalFilePath);
      if (
        relativeCanonical === ".." ||
        relativeCanonical.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativeCanonical)
      ) {
        throw new Error("electron-osx-sign resolved a target outside the app bundle");
      }
      const inherited = inheritedOptionsForFile?.(filePath) ?? {};
      const profile = signingProfileForPath(appPath, filePath, runtimePolicy);
      return {
        ...inherited,
        entitlements:
          profile === "jit" ? JIT_ENTITLEMENTS_PATH : EMPTY_ENTITLEMENTS_PATH,
        hardenedRuntime: true,
      };
    },
  });
}
