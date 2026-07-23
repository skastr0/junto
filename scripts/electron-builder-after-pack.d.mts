export declare const normalizeLinuxArtifactModes: (
  artifactRoot: string,
) => Promise<void>;

declare const afterPack: (context: unknown) => Promise<void>;

export default afterPack;
