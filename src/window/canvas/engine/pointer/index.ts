/** The hands (section 15): the pointer machine, its rules and edge auto-pan. */

export { AUTO_PAN_DISTANCE, AUTO_PAN_SPEED, autoPan } from "./auto-pan";
export {
  POINTER_IDLE,
  stepPointer,
  type ConnectPreview,
  type ConnectTarget,
  type PointerEffect,
  type PointerMachineEvent,
  type PointerState,
  type PointerStep,
  type PointerWorld,
} from "./machine";
export {
  BARE_MIN_SIZE,
  CARD_MIN_SIZE,
  CONNECT_SNAP_RADIUS,
  DRAG_THRESHOLD_PX,
  REGION_MIN_SIZE,
  VERB_ZONE_BLEED,
  resizeRuleFor,
  resizedRect,
  verbZones,
  type ResizeDirection,
  type ResizeRule,
  type VerbZone,
} from "./rules";
