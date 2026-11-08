export interface MacSigningConfig {
  readonly teamIdentifier: string;
  readonly signingIdentity: string;
  readonly builderIdentity: string;
}
export function resolveMacSigningConfig(environment?: NodeJS.ProcessEnv): MacSigningConfig;
