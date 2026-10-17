import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { ensureMachineDirectory, machineHomePath, ownedMachineFile } from "./install-paths";

declare const lockRootBrand: unique symbol;
export interface OwnedInstallLockRoot { readonly [lockRootBrand]: true }
const roots = new WeakMap<OwnedInstallLockRoot, string>();
/** Which lease check refused an install; the last library load failure stays as the cause. */
export const InstallLockCheck = Schema.Literals(["foreign-owner", "unowned-root", "lease-not-owned", "lease-unavailable", "held"]);
export class InstallLockRefused extends Schema.TaggedError<InstallLockRefused>()("InstallLockRefused", {
  check: InstallLockCheck,
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

/** Only an installation's exact owner marker admits its lock directory. */
export const admitInstallLockRoot = async (root: string, expectedOwner: string): Promise<OwnedInstallLockRoot> => {
  await machineHomePath(root);
  const marker = join(root, "owner.json");
  if (!await ownedMachineFile(marker) || await readFile(marker, "utf8") !== expectedOwner) throw new InstallLockRefused({ check: "foreign-owner", message: "This folder belongs to another Junto installation" });
  const handle = Object.freeze({}) as OwnedInstallLockRoot;
  roots.set(handle, root);
  return handle;
};

export const acquireInstallLock = async (handle: OwnedInstallLockRoot): Promise<() => Promise<void>> => {
  const root = roots.get(handle);
  if (root === undefined) throw new InstallLockRefused({ check: "unowned-root", message: "Install lock requires an owned installation" });
  const directory = join(root, ".install-lock");
  await ensureMachineDirectory(directory);
  const path = join(directory, "lease");
  await ownedMachineFile(path);
  const file = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  let library: { readonly symbols: { readonly flock: (descriptor: number, operation: number) => number }; close: () => void } | undefined;
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.uid !== process.getuid?.() || metadata.nlink !== 1 || metadata.mode & 0o077) throw new InstallLockRefused({ check: "lease-not-owned", message: "The install lock is not owned by Junto. Choose another install folder" });
    // The packaged CLI is Bun. Its built-in FFI holds the kernel lease in this
    // process, so a crash closes the descriptor and releases it automatically.
    const { dlopen } = await import("bun:ffi");
    const paths = process.platform === "darwin" ? ["/usr/lib/libSystem.B.dylib"]
      : process.platform === "linux" && process.arch === "x64" ? ["/lib/x86_64-linux-gnu/libc.so.6", "/lib64/libc.so.6", "/usr/lib64/libc.so.6"] : [];
    let loadFailure: unknown;
    for (const candidate of paths) {
      // Try the next absolute system library path; the last failure is the cause.
      try { library = dlopen(candidate, { flock: { args: ["i32", "i32"], returns: "i32" } }); break; } catch (cause) { loadFailure = cause; }
    }
    if (!library) throw new InstallLockRefused({ check: "lease-unavailable", message: "The system install lease is unavailable. Check this machine's operating system", ...(loadFailure === undefined ? {} : { cause: loadFailure }) });
    if (library.symbols.flock(file.fd, 2 | 4) !== 0) throw new InstallLockRefused({ check: "held", message: "Junto is already being sent to this machine. Wait for it to finish, then send again" });
  } catch (cause) {
    await file.close(); library?.close(); throw cause;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await file.close(); library?.close();
  };
};
