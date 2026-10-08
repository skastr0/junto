/**
 * The wire delivery target. One actor kind ⇒ one surface ⇒ one target shape,
 * so there is no discriminant left to carry.
 */
export type SurfaceDeliveryTarget = {
  readonly bindingId: string;
};
