import { Effect } from "effect";
import { MachineRepository } from "../../src/main/junto/machines/repository";
import { THIS_MACHINE } from "./machines";

/**
 * Name the test database's machine THIS_MACHINE. A first boot names a machine
 * from the hostname; a test names it here, before it seeds a canvas, so the
 * seats the node builders place on THIS_MACHINE resolve.
 */
export const nameThisMachine = Effect.flatMap(MachineRepository, (machine) =>
  machine.configureName(THIS_MACHINE));
