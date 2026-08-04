/** @type {import("jest").Config} */
module.exports = {
  extensionsToTreatAsEsm: [".ts"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  testEnvironment: "node",
  testMatch: ["<rootDir>/tests/**/*.test.ts"],
  // Many suites (the smoke tests, the CLI integration tests, the tool and
  // kernel tests) launch a real `node` child process via
  // execFile(process.execPath, ...). A warm exec of the node binary costs
  // ~45ms, but during a full run the binary's pages get evicted and a cold
  // exec costs 0.5-4.6s -- the time is spent entirely in exec, before node's
  // entry point, so the test can do nothing about it. Jest's 5s default left
  // those suites with no headroom, so whichever suite happened to catch a cold
  // exec timed out; the victim moved between runs. This budget is for catching
  // genuinely hung tests, not for policing subprocess latency.
  testTimeout: 30000,
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        tsconfig: "<rootDir>/tsconfig.test.json",
        useESM: true,
      },
    ],
  },
};
