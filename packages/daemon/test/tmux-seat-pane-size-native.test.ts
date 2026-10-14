import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { execArgvCommand, execCommand } from "../src/adapters/tmux-exec.js";

// A detached tmux session is 80x24, and the next client to attach resizes it to itself. Claude's footer
// is cut short in a narrow pane, so a new seat is created large and keeps its size.

let nativeAvailable = process.platform !== "win32";
try { execFileSync("tmux", ["-V"], { timeout: 2000, stdio: "ignore" }); } catch { nativeAvailable = false; }

const runFile = promisify(execFile);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-pane-"));
const env: NodeJS.ProcessEnv = { ...process.env, TMUX_TMPDIR: root, HOME: root, SHELL: "/bin/sh" };
delete env.TMUX;
const tmux = async (...args: string[]) => (await runFile("tmux", ["-f", "/dev/null", ...args], { env })).stdout.trim();
const size = (session: string) => tmux("display-message", "-p", "-t", session, "#{window_width}x#{window_height}");

describe.skipIf(!nativeAvailable)("new seat session size (native tmux)", () => {
  beforeAll(async () => {
    vi.stubEnv("TMUX", undefined);
    vi.stubEnv("TMUX_TMPDIR", root);
    await tmux("new-session", "-d", "-s", "anchor", "sleep 600");
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await tmux("kill-server").catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each(["shell", "argv"] as const)("%s transport: a seat is created 200x50 and a narrow client attached later does not shrink it", async mode => {
    const adapter = new TmuxAdapter(execCommand, undefined, mode === "argv" ? execArgvCommand : undefined);
    const name = `seat-${mode}`;
    expect(await adapter.createSession(name, root)).toEqual({ ok: true });
    expect(await size(name)).toBe("200x50");
    expect(await tmux("show-options", "-v", "-t", name, "window-size")).toBe("manual");

    // A control-mode client that reports a 30x10 terminal, which a default session would shrink to.
    const client = spawn("tmux", ["-f", "/dev/null", "-C", "attach", "-t", name], { env, stdio: ["pipe", "ignore", "ignore"] });
    try {
      client.stdin.write("refresh-client -C 30x10\n");
      for (let i = 0; i < 40 && Number(await tmux("list-clients", "-t", name, "-F", "#{client_width}").catch(() => "0")) !== 30; i++) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      expect(await tmux("list-clients", "-t", name, "-F", "#{client_width}")).toBe("30");
      expect(await size(name)).toBe("200x50");
    } finally {
      client.kill();
    }
  });
});
