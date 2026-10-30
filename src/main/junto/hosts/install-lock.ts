import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { ensureMachineDirectory, machineHomePath, ownedMachineFile } from "./install-paths";

declare const lockRootBrand: unique symbol;
export interface OwnedInstallLockRoot { readonly [lockRootBrand]: true }
const roots = new WeakMap<OwnedInstallLockRoot, string>();
/** Which lease check refused an install; the native lease helper's failure stays as the cause. */
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
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.uid !== process.getuid?.() || metadata.nlink !== 1 || metadata.mode & 0o077) throw new InstallLockRefused({ check: "lease-not-owned", message: "The install lock is not owned by Junto. Choose another install folder" });
    // Node has no flock(2). The bundle's native junto takes it on this same
    // open file description, handed over as its stdin, so the kernel lease
    // lasts while this process holds the descriptor and a crash releases it.
    const helper = process.env.JUNTO_NATIVE_CLI;
    const taken = helper === undefined ? undefined : spawnSync(helper, ["machine", "install-lease"], { stdio: [file.fd, "ignore", "pipe"], encoding: "utf8" });
    if (taken?.status === 1) throw new InstallLockRefused({ check: "held", message: "Junto is already being sent to this machine. Wait for it to finish, then send again" });
    if (taken?.status !== 0) throw new InstallLockRefused({ check: "lease-unavailable", message: "The system install lease is unavailable. Check this machine's operating system", ...(taken === undefined ? {} : { cause: taken.error ?? taken.stderr }) });
  } catch (cause) {
    await file.close(); throw cause;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await file.close();
  };
};
