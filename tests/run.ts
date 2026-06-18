import { run } from "./harness.js";
import "./cli/parseArgs.test.js";
import "./cli/cliIntegration.test.js";
import "./agent/runAgent.test.js";
import "./agent/readOnlySessionLoop.test.js";
import "./config/config.test.js";
import "./config/env.test.js";
import "./models/deepSeekProvider.test.js";
import "./sessions/sessionReadModel.test.js";

await run();
