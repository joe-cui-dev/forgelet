#!/usr/bin/env node
import { parseArgs } from "./parseArgs.js";
import { helpText } from "./help.js";
import { runAgent } from "../agent/runAgent.js";

async function main(): Promise<void> {
  const command = parseArgs(process.argv.slice(2));

  switch (command.kind) {
    case "help":
      console.log(helpText());
      return;
    case "version":
      console.log("0.1.0");
      return;
    case "run": {
      const result = await runAgent({
        task: command.task,
        contextFiles: command.contextFiles,
        model: command.model,
        budgetUsd: command.budgetUsd,
        workspaceRoot: process.cwd()
      });
      console.log(result.summary);
      return;
    }
    case "config-get":
      console.log("Config support is scaffolded and will be implemented in a follow-up issue.");
      return;
    case "config-set":
      console.log(`Config set is scaffolded: ${command.key}=${command.value}`);
      return;
    case "sessions-list":
      console.log("Session listing is scaffolded and will be implemented in a follow-up issue.");
      return;
    case "sessions-show":
      console.log(`Session display is scaffolded for ${command.sessionId}.`);
      return;
    case "explain":
      console.log(`Explain mode is scaffolded for ${command.sessionId}.`);
      return;
    default: {
      const exhaustive: never = command;
      throw new Error(`Unhandled command: ${JSON.stringify(exhaustive)}`);
    }
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`forge: ${message}`);
  process.exitCode = 1;
});
