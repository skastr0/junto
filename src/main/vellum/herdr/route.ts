/** Immutable host route captured before a server startup flight begins. */
export interface HerdrServerRoute {
  readonly hostId: string;
  readonly kind: "local" | "remote";
  /** Remote SSH endpoint; null for the local daemon. */
  readonly endpoint: string | null;
}
