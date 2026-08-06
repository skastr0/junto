export const OPERATOR_CONTROL_SWITCH = "--vellum-command-operator-control";

export const operatorControlEnabledFromInitialArgv = (
  argv: ReadonlyArray<string>,
): boolean => argv.includes(OPERATOR_CONTROL_SWITCH);

export {
  appendAndWipeOperatorBytes,
  startOperatorControlServer,
  type OperatorControlServer,
  type OperatorControlServerOptions,
  type OperatorControlServerRuntime,
  type OperatorControlShutdownReceipt,
} from "./server";
