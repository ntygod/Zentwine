/** Prints the implemented pure wire schema; does not register, authorize or start a runtime. */
import { runtimeProtocolSchema } from "../packages/contracts/dist/runtime-protocol.js";
process.stdout.write(JSON.stringify(runtimeProtocolSchema, null, 2) + "\n");
