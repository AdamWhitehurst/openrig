import { describe, it, expect, afterAll } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SeatHandoverService } from "../src/domain/seat-handover-service.js";
import { mergeSeatEnv, seatEnvLaunchVars, SEAT_ENV_KEYS_VAR } from "../src/domain/seat-env.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { createDb } from "../src/db/connection.js";

// A one-off `rig up --env` value goes into the seat's tmux session environment at the first launch.
// A handover successor is respawned in that same session, so it must not inherit it. This drives the
// REAL handover against an ISOLATED tmux server (per-run -L socket, torn down by session name, never
// kill-server) and reads the successor shell's actual process environment.

const pexec = promisify(execFile);
const SOCK = `openrig-seatenv-${process.pid}`;
const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
delete cleanEnv.TMUX;
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const exec = async (cmd: string): Promise<string> => {
  const safe = cmd.startsWith("tmux ") ? `tmux -L ${SOCK} ${cmd.slice(5)}` : cmd;
  return (await pexec("sh", ["-c", safe], { env: cleanEnv })).stdout;
};
const tmux = (a: string) => exec(`tmux ${a}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const available = (() => { try { execFileSync("sh", ["-c", "command -v tmux"], { env: cleanEnv, stdio: "ignore" }); return process.platform === "linux"; } catch { return false; } })();

const SEAT = "dev-impl@envhandover-rig";
afterAll(async () => { await tmux(`kill-session -t ${q(SEAT)}`).catch(() => {}); });

async function paneEnviron(): Promise<Record<string, string>> {
  const pid = (await tmux(`list-panes -t ${q(SEAT)} -F '#{pane_pid}'`)).trim();
  const out: Record<string, string> = {};
  for (const entry of readFileSync(`/proc/${pid}/environ`, "utf8").split("\0")) {
    const eq = entry.indexOf("=");
    if (eq > 0) out[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return out;
}

describe("a one-off --env value and a handover successor (real tmux)", () => {
  it.runIf(available)("the successor gets the spec's env, not the first launch's one-off values", async () => {
    const db = createDb(); db.pragma("foreign_keys = ON"); migrate(db, ALL_MIGRATIONS);
    const rigRepo = new RigRepository(db), sessionRegistry = new SessionRegistry(db);
    const discoveryRepo = new DiscoveryRepository(db), eventBus = new EventBus(db);
    const rig = rigRepo.createRig("envhandover-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex", cwd: "/tmp", env: { SHARED: "from-spec", MEMBER_ONLY: "m" } });
    rigRepo.setRigEnv(rig.id, { RIG_ONLY: "r" });

    // The first launch, as NodeLauncher does it: spec env with the one-off over it, and the names recorded.
    const oneOff = { SHARED: "one-off-wins", ONLY_THIS_LAUNCH: "debug" };
    const adapter = new TmuxAdapter(exec);
    const created = await adapter.createSession(SEAT, "/tmp", {
      OPENRIG_NODE_ID: node.id,
      ...seatEnvLaunchVars(mergeSeatEnv(rigRepo.getEffectiveSeatEnv(node.id), oneOff)),
    });
    expect(created.ok).toBe(true);
    await sleep(200);
    const pane = (await tmux(`list-panes -t ${q(SEAT)} -F '#{pane_id}'`)).trim();
    await tmux(`send-keys -t ${q(pane)} -l -- ${q("trap 'exit 0' TERM")}`);
    await tmux(`send-keys -t ${q(pane)} Enter`);
    await sleep(200);

    // Before the handover the first pane has the one-off, and the session records its name.
    expect(await paneEnviron()).toMatchObject({ SHARED: "one-off-wins", ONLY_THIS_LAUNCH: "debug" });
    expect(await adapter.getSessionEnv(SEAT, SEAT_ENV_KEYS_VAR)).toContain("ONLY_THIS_LAUNCH");

    const session = sessionRegistry.registerSession(node.id, SEAT);
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateStartupStatus(session.id, "ready", new Date("2026-08-07T09:00:00Z").toISOString());
    sessionRegistry.updateBinding(node.id, { tmuxSession: SEAT, tmuxPane: pane });
    const runtime = {
      runtime: "codex",
      async launchHarness() { return { ok: true, resumeToken: "tok", resumeType: "codex_id" }; },
      async checkReady() { return { ready: true }; },
    };
    const service = new SeatHandoverService({
      db, rigRepo, sessionRegistry, discoveryRepo, eventBus,
      tmuxAdapter: adapter, runtimeAdapters: { codex: runtime as never },
      predecessorRecapResolver: () => ({ recap: [], recordPath: "/tmp/none.jsonl" }),
      readinessTimeoutMs: 3000, sleep,
    });

    const result = await service.handover({ seatRef: SEAT, reason: "context ~85%", source: "fresh", operator: "orch@seat" });
    expect(result.ok).toBe(true);
    await sleep(300);

    // The successor shell has the spec's env; the one-off name is gone and the one-off value is not kept.
    const env = await paneEnviron();
    expect(env).toMatchObject({ SHARED: "from-spec", MEMBER_ONLY: "m", RIG_ONLY: "r" });
    expect(env).not.toHaveProperty("ONLY_THIS_LAUNCH");
    expect(Object.values(env)).not.toContain("one-off-wins");
    // The session no longer carries it either, and its key list is the spec's (what managed Claude reads).
    expect(await adapter.getSessionEnv(SEAT, "ONLY_THIS_LAUNCH")).toBeUndefined();
    expect(await adapter.getSessionEnv(SEAT, "SHARED")).toBe("from-spec");
    expect((await adapter.getSessionEnv(SEAT, SEAT_ENV_KEYS_VAR))!.split(",").sort()).toEqual(["MEMBER_ONLY", "RIG_ONLY", "SHARED"]);
    db.close();
  }, 60_000);
});
