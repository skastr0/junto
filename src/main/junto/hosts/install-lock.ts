import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureMachineDirectory, machineHomePath, ownedMachineFile } from "./install-paths";

declare const lockRootBrand: unique symbol;
export interface OwnedInstallLockRoot { readonly [lockRootBrand]: true }
const roots = new WeakMap<OwnedInstallLockRoot, string>();

/** Only an installation's exact owner marker admits its lock directory. */
export const admitInstallLockRoot = async (root: string, expectedOwner: string): Promise<OwnedInstallLockRoot> => {
  await machineHomePath(root);
  const marker = join(root, "owner.json");
  if (!await ownedMachineFile(marker) || await readFile(marker, "utf8") !== expectedOwner) throw new Error("This folder belongs to another Junto installation");
  const handle = Object.freeze({}) as OwnedInstallLockRoot;
  roots.set(handle, root);
  return handle;
};

export const acquireInstallLock = async (handle: OwnedInstallLockRoot): Promise<() => Promise<void>> => {
  const root = roots.get(handle);
  if (root === undefined) throw new Error("Install lock requires an owned installation");
  const directory = join(root, ".install-lock");
  await ensureMachineDirectory(directory);
  const path = join(directory, "lease");
  await ownedMachineFile(path);
  const file = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  let library: { readonly symbols: { readonly flock: (descriptor: number, operation: number) => number }; close: () => void } | undefined;
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.uid !== process.getuid?.() || metadata.nlink !== 1 || metadata.mode & 0o077) throw new Error("The install lock is not owned by Junto. Choose another install folder");
    // The packaged CLI is Bun. Its built-in FFI holds the kernel lease in this
    // process, so a crash closes the descriptor and releases it automatically.
    const { dlopen } = await import("bun:ffi");
    const paths = process.platform === "darwin" ? ["/usr/lib/libSystem.B.dylib"]
      : process.platform === "linux" && process.arch === "x64" ? ["/lib/x86_64-linux-gnu/libc.so.6", "/lib64/libc.so.6", "/usr/lib64/libc.so.6"] : [];
    for (const candidate of paths) {
      try { library = dlopen(candidate, { flock: { args: ["i32", "i32"], returns: "i32" } }); break; } catch { /* Try another absolute system library path. */ }
    }
    if (!library) throw new Error("The system install lease is unavailable. Check this machine's operating system");
    if (library.symbols.flock(file.fd, 2 | 4) !== 0) throw new Error("Junto is already being sent to this machine. Wait for it to finish, then send again");
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
