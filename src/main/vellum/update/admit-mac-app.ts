import { constants as fsConstants, lstatSync } from "node:fs";
import { access } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { compiledMacSigningPolicy } from "../mac-signing-policy";
import { updateError } from "./errors";

/** Product identity — must match production packaging and deploy-darwin. */
const PRODUCT_NAME = "Vellum Command";
const APP_BUNDLE_NAME = `${PRODUCT_NAME}.app`;
const BUNDLE_IDENTIFIER = "skastr0.vellumcommand";
const ADMIT_TIMEOUT_MS = 30_000;

export type AdmitMacAppCommandResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type AdmitMacAppCommand = (
  command: string,
  args: readonly string[],
) => Promise<AdmitMacAppCommandResult>;

export type AdmitStagedMacAppOptions = {
  /**
   * Injected command runner for unit tests / non-codesign environments.
   * Production uses `/usr/bin/codesign` and `/usr/bin/plutil`.
   */
  readonly runCommand?: AdmitMacAppCommand;
  readonly expectedVersion?: string;
};

const defaultRunCommand: AdmitMacAppCommand = (command, args) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`${basename(command)} timed out after ${ADMIT_TIMEOUT_MS}ms`));
    }, ADMIT_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        code: code ?? 1,
        stdout,
        stderr,
      });
    });
  });

const runOrThrow = async (
  runCommand: AdmitMacAppCommand,
  command: string,
  args: readonly string[],
): Promise<string> => {
  const result = await runCommand(command, args);
  if (result.code !== 0) {
    const detail = `${result.stderr}\n${result.stdout}`.trim().slice(0, 1_000);
    throw new Error(
      `${basename(command)} rejected staged app${detail ? `: ${detail}` : ""}`,
    );
  }
  return result.stdout.trim();
};

/**
 * Admit a staged Mac `.app` before install mint.
 *
 * Checks: exact bundle name, executable identity, CFBundleIdentifier,
 * the build-owned Developer ID codesign requirement.
 *
 * Non-darwin callers should not reach this path; inject `runCommand` in tests.
 */
export const admitStagedMacApp = async (
  appPath: string,
  options: AdmitStagedMacAppOptions = {},
): Promise<void> => {
    try {
      const policy = compiledMacSigningPolicy();
      const runCommand = options.runCommand ?? defaultRunCommand;
      const canonicalPath = resolve(appPath);
      const root = lstatSync(canonicalPath);
      if (!root.isDirectory() || root.isSymbolicLink()) {
        throw new Error("staged app root must be a real directory");
      }
      if (basename(canonicalPath) !== APP_BUNDLE_NAME) {
        throw new Error(`staged app must be named ${APP_BUNDLE_NAME}`);
      }

      const infoPlistPath = join(canonicalPath, "Contents", "Info.plist");
      const executablePath = join(
        canonicalPath,
        "Contents",
        "MacOS",
        PRODUCT_NAME,
      );
      const plistMeta = lstatSync(infoPlistPath);
      const execMeta = lstatSync(executablePath);
      if (
        !plistMeta.isFile() ||
        plistMeta.isSymbolicLink() ||
        !execMeta.isFile() ||
        execMeta.isSymbolicLink()
      ) {
        throw new Error(
          "staged app Info.plist and Vellum Command executable must be regular files",
        );
      }
      await access(executablePath, fsConstants.X_OK);

      await runOrThrow(runCommand, "/usr/bin/codesign", [
        "--verify",
        "--deep",
        "--strict",
        "--verbose=2",
        "-R",
        policy.developerIdRequirement,
        canonicalPath,
      ]);

      const [bundleIdentifier, bundleExecutable] = await Promise.all([
        runOrThrow(runCommand, "/usr/bin/plutil", [
          "-extract",
          "CFBundleIdentifier",
          "raw",
          "-o",
          "-",
          infoPlistPath,
        ]),
        runOrThrow(runCommand, "/usr/bin/plutil", [
          "-extract",
          "CFBundleExecutable",
          "raw",
          "-o",
          "-",
          infoPlistPath,
        ]),
      ]);

      if (bundleIdentifier !== BUNDLE_IDENTIFIER) {
        throw new Error(
          `staged app CFBundleIdentifier must be ${BUNDLE_IDENTIFIER}`,
        );
      }
      if (bundleExecutable !== PRODUCT_NAME) {
        throw new Error(
          `staged app CFBundleExecutable must be ${PRODUCT_NAME}`,
        );
      }
      if (options.expectedVersion !== undefined) {
        const bundleVersion = await runOrThrow(runCommand, "/usr/bin/plutil", [
          "-extract", "CFBundleShortVersionString", "raw", "-o", "-", infoPlistPath,
        ]);
        if (bundleVersion !== options.expectedVersion) {
          throw new Error("staged app version does not match the advertised release");
        }
      }
    } catch (cause) {
      throw updateError(
        "readiness-failed",
        cause instanceof Error
          ? `staged app admission failed: ${cause.message}`
          : "staged app admission failed",
        cause,
      );
    }
  };
