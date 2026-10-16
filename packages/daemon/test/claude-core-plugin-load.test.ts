import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { RigTeardownOrchestrator } from "../src/domain/rig-teardown.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { SuccessorSessionLauncher } from "../src/domain/successor-session-launcher.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import type { ClaudeManagedLaunch } from "../src/domain/claude-managed-launch.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

// openrig-core ships hooks (refocus, the compaction-restore pair, the activity relay). Claude loads them
// only from a plugin it was told about, and nothing told it: the plugin sat in OpenRig's state, so a
// seat's PreCompact hook never wrote the restore-pending marker the managed post-compact prompt reads.
// The daemon now tells every Claude seat where the vendored plugin is (CLAUDE_CODE_PLUGIN_DIRS, no launch
// argument, so the seat's process identity is unchanged) and says the settings-based relay already
// reports activity, so the plugin's own relay stays quiet instead of posting every event a second time.

const require = createRequire(import.meta.url);
const PLUGIN_ENV = "CLAUDE_CODE_PLUGIN_DIRS";
const SETTINGS_OWN_RELAY = "OPENRIG_ACTIVITY_HOOKS_OWNED_BY_SETTINGS";

describe("the daemon's Claude plugin env", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "claude-core-plugin-")); });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

  it("is set by a real daemon startup to the vendored plugin, a path with no colon", async () => {
    // Every home the daemon touches at startup is a scratch one: the real ~/.claude and ~/.codex stay out of it.
    vi.stubEnv("HOME", join(root, "home"));
    vi.stubEnv("OPENRIG_HOME", join(root, "openrig"));
    vi.stubEnv("CODEX_HOME", join(root, "codex"));
    vi.stubEnv("CLAUDE_CONFIG_DIR", join(root, "claude"));
    const { createDaemon } = await import("../src/startup.js");
    const { db, deps } = await createDaemon({ dbPath: ":memory:" });
    try {
      const claude = deps.runtimeSessionEnv?.["claude-code"];
      expect(claude?.[PLUGIN_ENV]).toBe(join(root, "openrig", "plugins", "openrig-core"));
      expect(claude?.[PLUGIN_ENV]).not.toContain(":");
      expect(claude?.[SETTINGS_OWN_RELAY]).toBe("1");
      // Only Claude gets it: Codex has no such variable, and its seats' env stays as it was.
      expect(deps.runtimeSessionEnv?.codex).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("is left out when the plugin is not vendored", async () => {
    const { claudeCorePluginEnv } = await import("../src/domain/claude-core-plugin-env.js");
    expect(claudeCorePluginEnv(join(root, "plugins"))).toBeUndefined();
    mkdirSync(join(root, "plugins", "openrig-core"), { recursive: true });
    expect(claudeCorePluginEnv(join(root, "plugins"))).toBeUndefined();
    mkdirSync(join(root, "plugins", "openrig-core", ".claude-plugin"));
    writeFileSync(join(root, "plugins", "openrig-core", ".claude-plugin", "plugin.json"), "{}");
    expect(claudeCorePluginEnv(join(root, "plugins"))).toEqual({
      [PLUGIN_ENV]: join(root, "plugins", "openrig-core"),
      [SETTINGS_OWN_RELAY]: "1",
    });
  });
});

describe("a Claude seat's launch env carries the plugin on every path", () => {
  const dbs: ReturnType<typeof createFullTestDb>[] = [];
  afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
  const claudeEnv = { "claude-code": { [PLUGIN_ENV]: "/state/plugins/openrig-core", [SETTINGS_OWN_RELAY]: "1" } };

  it("fresh launch: the first pane's session env has it for Claude and not for Codex", async () => {
    const db = createFullTestDb(); dbs.push(db);
    const rigRepo = new RigRepository(db);
    const rig = rigRepo.createRig("plugin-env");
    rigRepo.addNode(rig.id, "dev.claude", { runtime: "claude-code" });
    rigRepo.addNode(rig.id, "dev.codex", { runtime: "codex" });
    const created: Array<Record<string, string> | undefined> = [];
    const tmux = {
      createSession: async (_n: string, _c?: string, env?: Record<string, string>) => { created.push(env); return { ok: true as const }; },
      setSessionEnv: async () => {}, unsetSessionEnv: async () => {},
      killSession: async () => ({ ok: true as const }), listPanes: async () => [], listSessions: async () => [], hasSession: async () => false,
    } as unknown as TmuxAdapter;
    const launcher = new NodeLauncher({ db, rigRepo, sessionRegistry: new SessionRegistry(db), eventBus: new EventBus(db),
      tmuxAdapter: tmux, sessionEnv: { OPENRIG_HOME: "/state" }, runtimeSessionEnv: claudeEnv });
    expect((await launcher.launchNode(rig.id, "dev.claude")).ok).toBe(true);
    expect((await launcher.launchNode(rig.id, "dev.codex")).ok).toBe(true);
    expect(created[0]).toMatchObject({ [PLUGIN_ENV]: "/state/plugins/openrig-core", [SETTINGS_OWN_RELAY]: "1" });
    expect(created[1]).not.toHaveProperty(PLUGIN_ENV);
    expect(created[1]).not.toHaveProperty(SETTINGS_OWN_RELAY);
  });

  it("handover successor: the respawned pane has it", async () => {
    const db = createFullTestDb(); dbs.push(db);
    const respawnPane = vi.fn(async () => ({ ok: true }));
    const tmux = {
      createSession: vi.fn(async () => ({ ok: true })),
      listPanes: vi.fn(async () => [{ id: "%7", index: 0, cwd: "/w", width: 80, height: 24, active: true }]),
      killSession: vi.fn(async () => ({ ok: true })), respawnPane, setRemainOnExit: vi.fn(async () => ({ ok: true })),
      signalPaneProcess: vi.fn(async () => ({ ok: true })), isPaneDead: vi.fn(async () => true),
      getDefaultShell: vi.fn(async () => "/bin/zsh"), getPaneCommand: vi.fn(async () => "zsh"),
    } as unknown as TmuxAdapter;
    const adapter = { runtime: "claude-code", launchHarness: vi.fn(async () => ({ ok: true, resumeToken: "t", resumeType: "claude_id" })),
      checkReady: vi.fn(async () => ({ ready: true })) } as unknown as RuntimeAdapter;
    const launcher = new SuccessorSessionLauncher(tmux, new DiscoveryRepository(db), {
      sessionEnv: { OPENRIG_HOME: "/state" }, runtimeSessionEnv: claudeEnv, newId: () => "01ABCDEFG",
      runtimeAdapters: { "claude-code": adapter }, readinessTimeoutMs: 50, sleep: async () => {}, exitPollMs: 1, exitTimeoutMs: 5,
    });
    const res = await launcher.createSuccessor({ node: { id: "node-1", runtime: "claude-code", cwd: "/w" }, departingSessionName: "dev-claude@rig" });
    expect(res.ok).toBe(true);
    expect((respawnPane.mock.calls[0] as unknown[])[2]).toMatchObject({ env: { [PLUGIN_ENV]: "/state/plugins/openrig-core", [SETTINGS_OWN_RELAY]: "1" } });
  });

  it("restore: the relaunched session is created through the same env", async () => {
    const db = createFullTestDb(); dbs.push(db);
    const rigRepo = new RigRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    const snapshotRepo = new SnapshotRepository(db);
    const checkpointStore = new CheckpointStore(db);
    const snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore });
    const rig = rigRepo.createRig("restore-test");
    db.prepare("INSERT INTO pods (id, rig_id, label) VALUES (?, ?, ?)").run("restore-pod", rig.id, "Test");
    const node = rigRepo.addNode(rig.id, "test.c", { runtime: "claude-code", podId: "restore-pod" });
    const name = "test-c@restore-test";
    const token = "00000000-0000-4000-8000-000000000006";
    const old = sessionRegistry.registerSession(node.id, name);
    sessionRegistry.updateStatus(old.id, "running");
    sessionRegistry.updateResumeToken(old.id, "claude_id", token, "scrape");
    sessionRegistry.updateBinding(node.id, { tmuxSession: name, tmuxPane: "%old" });
    db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)").run(node.id, "[]", "[]", "[]", "claude-code");
    let live = true;
    const created: Array<Record<string, string> | undefined> = [];
    const tmux = {
      hasSession: vi.fn(async () => live), probeSession: vi.fn(async () => ({ state: live ? "present" : "absent" })),
      killSession: vi.fn(async () => { live = false; return { ok: true }; }),
      createSession: vi.fn(async (_n: string, _c?: string, env?: Record<string, string>) => { live = true; created.push(env); return { ok: true }; }),
      setSessionEnv: vi.fn(async () => {}), unsetSessionEnv: vi.fn(async () => {}),
      listSessions: vi.fn(async () => live ? [{ name }] : []), listWindows: vi.fn(async () => []),
      listPanes: vi.fn(async () => [{ id: "%new", index: 0, cwd: "/", width: 80, height: 24, active: true }]),
      getPanePid: vi.fn(async () => 100), getPaneCommand: vi.fn(async () => "sh"),
      capturePaneContent: vi.fn(async () => "Restored conversation\n❯ \n"),
      sendText: vi.fn(async () => ({ ok: true })), sendShellCommand: vi.fn(async () => ({ ok: true })), sendKeys: vi.fn(async () => ({ ok: true })),
    } as unknown as TmuxAdapter;
    const listProcesses = async () => [];
    const down = await new RigTeardownOrchestrator({ db, rigRepo, sessionRegistry, eventBus, snapshotCapture, tmuxAdapter: tmux }).teardown(rig.id);
    expect(down.errors).toEqual([]);
    const adapter = new ClaudeCodeAdapter({ tmux, listProcesses, sleep: async () => {},
      claudeManagedLaunch: { prepare: async () => ({ command: (args: readonly string[]) => `claude ${args.join(" ")}`, assertCurrent: () => {}, configDir: "/fixture", executable: "/opt/claude.exe" }) } as unknown as ClaudeManagedLaunch,
      fsOps: { exists: () => false, readFile: () => "", writeFile: () => {}, mkdirp: () => {}, copyFile: () => {} } });
    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux, sessionEnv: { OPENRIG_HOME: "/state" }, runtimeSessionEnv: claudeEnv });
    const restore = new RestoreOrchestrator({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
      checkpointStore, nodeLauncher, tmuxAdapter: tmux, claudeResume: new ClaudeResumeAdapter(tmux),
      codexResume: new CodexResumeAdapter(tmux), listProcesses });
    await restore.restore(down.snapshotId!, { adapters: { "claude-code": adapter } });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ [PLUGIN_ENV]: "/state/plugins/openrig-core", [SETTINGS_OWN_RELAY]: "1" });
  });
});

describe("the plugin's activity relay", () => {
  const relayPath = require.resolve("../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs");
  let server: Server;
  let posts: Array<{ url: string; body: string }>;
  let port: number;

  beforeEach(async () => {
    posts = [];
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => { posts.push({ url: req.url ?? "", body }); res.end("{}"); });
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    port = (server.address() as { port: number }).port;
  });
  afterEach(async () => { await new Promise<void>((ok) => server.close(() => ok())); });

  function run(extraEnv: Record<string, string>, payload: Record<string, unknown>, args: string[] = []): Promise<void> {
    return new Promise((done, fail) => {
      const child = spawn(process.execPath, [relayPath, ...args], {
        env: { PATH: process.env.PATH ?? "", OPENRIG_SESSION_NAME: "dev-claude@rig", OPENRIG_NODE_ID: "node-1", OPENRIG_RUNTIME: "claude-code",
          OPENRIG_URL: `http://127.0.0.1:${port}`, OPENRIG_ACTIVITY_HOOK_TOKEN: "tok", ...extraEnv },
        stdio: ["pipe", "ignore", "ignore"],
      });
      child.on("error", fail);
      child.on("close", () => done());
      child.stdin.end(JSON.stringify(payload));
    });
  }

  it("posts a hook event and a session start when nothing says the settings relay has it", async () => {
    await run({}, { hook_event_name: "SessionStart", session_id: "s-1", source: "startup" }, ["--from-plugin"]);
    expect(posts.map((p) => p.url)).toEqual(["/api/activity/hooks", "/api/activity/hooks"]);
  });

  it("posts nothing, as the plugin's copy, when the daemon says the settings relay reports activity", async () => {
    await run({ [SETTINGS_OWN_RELAY]: "1" }, { hook_event_name: "SessionStart", session_id: "s-1", source: "startup" }, ["--from-plugin"]);
    await run({ [SETTINGS_OWN_RELAY]: "1" }, { hook_event_name: "UserPromptSubmit", session_id: "s-1" }, ["--from-plugin"]);
    expect(posts).toEqual([]);
  });

  it("still reports as the settings copy, which is the same script started without --from-plugin", async () => {
    await run({ [SETTINGS_OWN_RELAY]: "1" }, { hook_event_name: "UserPromptSubmit", session_id: "s-1" });
    expect(posts.map((p) => p.url)).toEqual(["/api/activity/hooks"]);
  });

  it("is started with --from-plugin by every Claude manifest entry and by no Codex one", () => {
    const hookRoot = join(relayPath, "..", "..");
    const commands = (file: string): string[] => {
      const hooks = JSON.parse(readFileSync(join(hookRoot, file), "utf8")).hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
      return Object.values(hooks).flatMap((groups) => groups.flatMap((g) => g.hooks.map((h) => h.command))).filter((c) => c.includes("activity-relay.cjs"));
    };
    expect(commands("claude.json").length).toBeGreaterThan(0);
    expect(commands("claude.json").every((c) => c.endsWith(" --from-plugin"))).toBe(true);
    expect(commands("codex.json").some((c) => c.includes("--from-plugin"))).toBe(false);
  });
});
