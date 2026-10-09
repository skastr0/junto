import path from "node:path";

// Immutable packages sent to another machine. Signing must not change their
// inventoried bytes; the enclosing app resource seal authenticates the payload.
export const MACHINE_PAYLOAD_MACHO_PATHS = [
  "Contents/Resources/machines/darwin-arm64/bin/junto",
  "Contents/Resources/machines/darwin-arm64/bin/node",
  "Contents/Resources/machines/darwin-arm64/core/node_modules/node-pty/build/Release/pty.node",
  "Contents/Resources/machines/darwin-arm64/core/node_modules/node-pty/build/Release/spawn-helper",
];

export const isMachinePayloadPath = (appPath, filePath) => {
  const relative = path.relative(path.resolve(appPath), path.resolve(filePath)).split(path.sep).join("/");
  return ["darwin-arm64", "linux-x64"].some(target => {
    const root = `Contents/Resources/machines/${target}`;
    return relative === root || relative.startsWith(root + "/");
  });
};
