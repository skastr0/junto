/**
 * Path admission for DesiredFile apply (local + remote).
 *
 * - Expand `~` / `~/…`
 * - Refuse NUL, empty, and `..` escape outside an optional confinement root
 * - Absolute packager paths (often under HOME or a plan root) write as given
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { Effect, Schema } from "effect";

export class PathSafetyError extends Schema.TaggedError<PathSafetyError>()("PathSafetyError", {
  path: Schema.String,
  message: Schema.String,
}) {}

/** SHA-256 hex of UTF-8 content — matches packager content-hash. */
export const contentHash = (content: string): string =>
  createHash("sha256").update(content, "utf8").digest("hex");

export const expandUserPath = (path: string, home: string = process.env.HOME ?? homedir()): string => {
  if (path === "~") return home;
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return joinHome(home, path.slice(2));
  }
  return path;
};

const joinHome = (home: string, rest: string): string => {
  const trimmed = rest.replace(/^[\\/]+/u, "");
  return trimmed.length === 0 ? home : `${home.replace(/[\\/]+$/u, "")}${sep}${trimmed.split(/[\\/]/u).join(sep)}`;
};

/**
 * Admit a DesiredFile target path for write.
 *
 * @param root - Optional confinement root. When set, resolved path must stay
 *   inside it (no `..` escape). When omitted, absolute paths are accepted as-is
 *   after `~` expand; relative paths without a root are refused.
 */
export const admitDesiredTargetPath = (
  targetPath: string,
  options: { readonly root?: string; readonly home?: string } = {},
): Effect.Effect<string, PathSafetyError> => {
  if (typeof targetPath !== "string" || targetPath.length === 0) {
    return Effect.fail(
      new PathSafetyError({ path: String(targetPath), message: "target path is empty" }),
    );
  }
  if (targetPath.includes("\0")) {
    return Effect.fail(
      new PathSafetyError({ path: targetPath, message: "target path contains NUL" }),
    );
  }
  if (Buffer.byteLength(targetPath, "utf8") > 4096) {
    return Effect.fail(
      new PathSafetyError({ path: targetPath, message: "target path exceeds 4096 bytes" }),
    );
  }

  const home = options.home ?? process.env.HOME ?? homedir();
  const expanded = expandUserPath(targetPath, home);

  if (options.root !== undefined) {
    const rootResolved = resolve(expandUserPath(options.root, home));
    const candidate = isAbsolute(expanded)
      ? resolve(expanded)
      : resolve(rootResolved, expanded);
    const rel = relative(rootResolved, candidate);
    if (rel === "" || rel === "..") {
      // empty rel means exact root — refuse writing the root itself as a file
      if (rel === "") {
        return Effect.fail(
          new PathSafetyError({
            path: targetPath,
            message: "refusing to write the confinement root itself",
          }),
        );
      }
    }
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return Effect.fail(
        new PathSafetyError({
          path: targetPath,
          message: `path escapes confinement root ${rootResolved}`,
        }),
      );
    }
    // Reject any remaining `..` segments after normalize (paranoia)
    const normalized = normalize(candidate);
    if (normalized.split(sep).includes("..")) {
      return Effect.fail(
        new PathSafetyError({
          path: targetPath,
          message: "path contains parent segments after normalize",
        }),
      );
    }
    return Effect.succeed(normalized);
  }

  // No root: absolute only (packager emits absolute plan / HOME paths).
  if (!isAbsolute(expanded)) {
    return Effect.fail(
      new PathSafetyError({
        path: targetPath,
        message: "relative target path requires a confinement root",
      }),
    );
  }
  const absolute = resolve(expanded);
  if (absolute.split(sep).includes("..")) {
    return Effect.fail(
      new PathSafetyError({
        path: targetPath,
        message: "path contains parent segments after resolve",
      }),
    );
  }
  return Effect.succeed(absolute);
};

/** POSIX absolute path safe for remote shell quoting (no metacharacters). */
const SAFE_REMOTE_ABS =
  /^\/(?:[A-Za-z0-9._+-]+\/)*[A-Za-z0-9._+-]+$/u;

export const admitRemoteAbsPath = (
  path: string,
): Effect.Effect<string, PathSafetyError> => {
  if (
    typeof path !== "string" ||
    !SAFE_REMOTE_ABS.test(path) ||
    path.includes("..") ||
    path.includes("\0") ||
    Buffer.byteLength(path, "utf8") > 512
  ) {
    return Effect.fail(
      new PathSafetyError({
        path: String(path),
        message: "remote path must be a clean absolute POSIX path",
      }),
    );
  }
  return Effect.succeed(path);
};

export const shellSingleQuote = (value: string): string =>
  `'${value.replace(/'/g, `'\\''`)}'`;
