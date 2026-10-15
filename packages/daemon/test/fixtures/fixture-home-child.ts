// Runs as a child of fixture-home-cleanup.test.ts: loads the shared vitest setup in a plain Node process,
// prints the homes it ended up with, and exits.
import "../../../../test/hermetic-env.setup.js";

console.log(JSON.stringify({ openrigHome: process.env["OPENRIG_HOME"], home: process.env["HOME"] }));
// With "wait", stay alive for the test to signal: a vitest worker is ended with SIGTERM while it is running.
if (process.argv[2] === "wait") setInterval(() => {}, 1000);
