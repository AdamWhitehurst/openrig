import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

// The shared vitest setup makes a fixture home and a sibling user home per worker. It removes them when the
// worker exits; before, a full run left two behind per worker and filled the (RAM-backed) /tmp.
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function runSetup(env: Record<string, string | undefined> = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fixture-home-run-"));
  roots.push(tmp);
  const child = spawnSync(process.execPath, [
    "--import", createRequire(import.meta.url).resolve("tsx"),
    path.join(import.meta.dirname, "fixtures/fixture-home-child.ts"),
  ], {
    encoding: "utf-8", timeout: 60_000,
    env: { PATH: process.env.PATH, TMPDIR: tmp, ...env },
  });
  expect(child.status, child.stderr).toBe(0);
  const homes = JSON.parse(child.stdout.trim().split("\n").pop()!) as { openrigHome: string; home: string };
  return { tmp, ...homes };
}
const fixtureEntries = (tmp: string) => fs.readdirSync(tmp).filter((name) => name.startsWith(".openrig-test-fixture-home-"));

describe.skipIf(process.env["OPENRIG_E2E_REAL_CODEX"] === "1")("fixture homes are removed when the worker exits", () => {
  it("removes the fixture home and the user home", () => {
    const { tmp, openrigHome, home } = runSetup();
    expect(path.dirname(openrigHome)).toBe(tmp);
    expect(home).toBe(`${openrigHome}-user-home`);
    expect(fs.existsSync(openrigHome)).toBe(false);
    expect(fs.existsSync(home)).toBe(false);
    expect(fixtureEntries(tmp)).toEqual([]);
  });

  it.each(["SIGTERM", "SIGINT", "SIGHUP"] as const)("removes both homes when the worker is ended by %s, and still dies of it", async (signal) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fixture-home-signal-"));
    roots.push(tmp);
    const child = spawn(process.execPath, [
      "--import", createRequire(import.meta.url).resolve("tsx"),
      path.join(import.meta.dirname, "fixtures/fixture-home-child.ts"), "wait",
    ], { stdio: ["ignore", "pipe", "inherit"], env: { PATH: process.env.PATH, TMPDIR: tmp } });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.once("close", (code, sig) => resolve({ code, signal: sig })));
    try {
      let output = "";
      const homes = await new Promise<{ openrigHome: string; home: string }>((resolve, reject) => {
        child.stdout!.on("data", (chunk: Buffer) => {
          output += String(chunk);
          const line = output.split("\n").find((l) => l.startsWith("{") && l.endsWith("}"));
          if (line) resolve(JSON.parse(line));
        });
        child.once("close", () => reject(new Error(`child ended before it printed its homes: ${output}`)));
      });
      // Alive, and with both homes on disk, when the signal arrives.
      expect(fs.existsSync(homes.openrigHome)).toBe(true);
      expect(fs.existsSync(homes.home)).toBe(true);

      child.kill(signal);

      expect(await closed).toEqual({ code: null, signal });
      expect(fs.existsSync(homes.openrigHome)).toBe(false);
      expect(fs.existsSync(homes.home)).toBe(false);
      expect(fixtureEntries(tmp)).toEqual([]);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("leaves a fixture home it only reused, which belongs to whoever made it", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fixture-home-parent-"));
    roots.push(tmp);
    const parentHome = path.join(tmp, ".openrig-test-fixture-home-parent");
    fs.mkdirSync(parentHome);
    fs.writeFileSync(path.join(parentHome, ".openrig-fixture"), "");

    const { openrigHome } = runSetup({ OPENRIG_HOME: parentHome });

    expect(openrigHome).toBe(parentHome);
    expect(fs.existsSync(path.join(parentHome, ".openrig-fixture"))).toBe(true);
  });

  it("never touches an OPENRIG_HOME from the environment that has no marker", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fixture-home-owner-"));
    roots.push(tmp);
    fs.writeFileSync(path.join(tmp, "state.db"), "owner state");

    const { openrigHome } = runSetup({ OPENRIG_HOME: tmp });

    expect(openrigHome).not.toBe(tmp);
    expect(fs.readFileSync(path.join(tmp, "state.db"), "utf-8")).toBe("owner state");
  });
});
