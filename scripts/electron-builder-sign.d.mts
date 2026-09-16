interface RuntimeSigningPolicy {
  readonly machO: ReadonlyArray<{
    readonly path: string;
    readonly profile: "none" | "jit";
  }>;
}

export declare const signingProfileForPath: (
  appPath: string,
  filePath: string,
  runtimePolicy: RuntimeSigningPolicy,
) => "none" | "jit";

declare const signJuntoApp: (options: Record<string, unknown>) => Promise<void>;
export default signJuntoApp;
