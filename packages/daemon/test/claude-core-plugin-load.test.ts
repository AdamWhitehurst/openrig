import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer, type Server } from "node:http";
import Database from "better-sqlite3";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { ClaudeManagedLaunch as RealManagedLaunch } from "../src/domain/claude-managed-launch.js";
import type { ClaudeManagedLaunch } from "../src/domain/claude-managed-launch.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

// openrig-core ships hooks (refocus, the compaction-restore pair, the activity relay). Claude loads them
// only from a plugin it was told about, and nothing told it: the plugin sat in OpenRig's state, so a
// seat's PreCompact hook never wrote the restore-pending marker the managed post-compact prompt reads.
// The daemon now tells every Claude seat where the vendored plugin is (CLAUDE_CODE_PLUGIN_DIRS, no launch
// argument, so the seat's process identity is unchanged). A seat's own CLAUDE_CODE_PLUGIN_DIRS keeps working and the
// vendored plugin is added to it. The plugin's own activity relay stays quiet for an event only when the seat's
// settings.local.json carries OpenRig's copy of the relay for that event, so each event is reported once either way.

const require = createRequire(import.meta.url);
const PLUGIN_ENV = "CLAUDE_CODE_PLUGIN_DIRS";
const OWN_LIST = "/own/plugins:/more/plugins";
const VENDORED = "/state/plugins/openrig-core";
const SETTINGS_RELAY = "/state/state/claude-activity-hooks/activity-relay.cjs";

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
      expect(Object.keys(claude ?? {})).toEqual([PLUGIN_ENV]);
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
    expect(claudeCorePluginEnv(join(root, "plugins"))).toEqual({ [PLUGIN_ENV]: join(root, "plugins", "openrig-core") });
  });
});

describe("a Claude seat's launch env carries the plugin on every path", () => {
  const dbs: ReturnType<typeof createFullTestDb>[] = [];
  afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
  const claudeEnv = { "claude-code": { [PLUGIN_ENV]: VENDORED } };

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
    expect(created[0]).toMatchObject({ [PLUGIN_ENV]: VENDORED });
    expect(created[1]).not.toHaveProperty(PLUGIN_ENV);
  });

  it("fresh launch: a seat's own list keeps working and the vendored plugin is added to it", async () => {
    const db = createFullTestDb(); dbs.push(db);
    const rigRepo = new RigRepository(db);
    const rig = rigRepo.createRig("plugin-env-own");
    rigRepo.addNode(rig.id, "own", { runtime: "claude-code", env: { [PLUGIN_ENV]: OWN_LIST } });
    rigRepo.addNode(rig.id, "has-it", { runtime: "claude-code", env: { [PLUGIN_ENV]: `/own/plugins:${VENDORED}` } });
    rigRepo.addNode(rig.id, "plain", { runtime: "claude-code" });
    rigRepo.addNode(rig.id, "oneoff", { runtime: "claude-code" });
    const created: Array<Record<string, string> | undefined> = [];
    const sessionEnvCalls: string[] = [];
    const tmux = {
      createSession: async (_n: string, _c?: string, env?: Record<string, string>) => { created.push(env); return { ok: true as const }; },
      setSessionEnv: async (_s: string, key: string, value: string) => { sessionEnvCalls.push(`set ${key}=${value}`); },
      unsetSessionEnv: async (_s: string, key: string) => { sessionEnvCalls.push(`unset ${key}`); },
      killSession: async () => ({ ok: true as const }), listPanes: async () => [], listSessions: async () => [], hasSession: async () => false,
    } as unknown as TmuxAdapter;
    const launcher = new NodeLauncher({ db, rigRepo, sessionRegistry: new SessionRegistry(db), eventBus: new EventBus(db),
      tmuxAdapter: tmux, sessionEnv: { OPENRIG_HOME: "/state" }, runtimeSessionEnv: claudeEnv });
    for (const id of ["own", "has-it", "plain"]) expect((await launcher.launchNode(rig.id, id)).ok).toBe(true);
    expect(created[0]![PLUGIN_ENV]).toBe(`${OWN_LIST}:${VENDORED}`);
    expect(created[1]![PLUGIN_ENV]).toBe(`/own/plugins:${VENDORED}`);
    expect(created[2]![PLUGIN_ENV]).toBe(VENDORED);
    // A one-off `rig up --env` list is composed too, and once the first pane has it the session goes back to the vendored plugin.
    const oneOff = await launcher.launchNode(rig.id, "oneoff", { env: { [PLUGIN_ENV]: "/one/off" } });
    expect(oneOff.ok, JSON.stringify(oneOff)).toBe(true);
    expect(created[3]![PLUGIN_ENV]).toBe(`/one/off:${VENDORED}`);
    expect(sessionEnvCalls).toContain(`set ${PLUGIN_ENV}=${VENDORED}`);
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
    expect((respawnPane.mock.calls[0] as unknown[])[2]).toMatchObject({ env: { [PLUGIN_ENV]: VENDORED } });
  });

  it("handover successor: a seat's own list keeps working and the vendored plugin is added to it", async () => {
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
    const res = await launcher.createSuccessor({ node: { id: "node-1", runtime: "claude-code", cwd: "/w", seatEnv: { [PLUGIN_ENV]: OWN_LIST } }, departingSessionName: "dev-claude@rig" });
    expect(res.ok).toBe(true);
    expect((respawnPane.mock.calls[0] as unknown[])[2]).toMatchObject({ env: { [PLUGIN_ENV]: `${OWN_LIST}:${VENDORED}` } });
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
    const node = rigRepo.addNode(rig.id, "test.c", { runtime: "claude-code", podId: "restore-pod", env: { [PLUGIN_ENV]: OWN_LIST } });
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
    // The seat declared its own list; restore keeps it and adds the vendored plugin, through the same launch env.
    expect(created[0]).toMatchObject({ [PLUGIN_ENV]: `${OWN_LIST}:${VENDORED}` });
  });
});

// A Claude seat with a permission mode starts through ClaudeManagedLaunch, whose command is `/usr/bin/env -i`: it keeps only
// the keys it lists, so the variable the session env holds never reached such a seat. These run the command it builds in a
// real shell and read back what a fake claude process was left with.
describe.skipIf(process.platform === "win32")("the managed (env -i) Claude launch carries the plugin list", () => {
  const exec = promisify(execFile);
  const cleanup: Array<() => void> = [];
  afterEach(() => { for (const f of cleanup.splice(0)) f(); });

  function fixture(opts: { memberEnv?: object; runtimeEnv?: Record<string, Record<string, string>> }) {
    const root = mkdtempSync(join(tmpdir(), "managed-plugin-dirs-"));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const bin = join(root, "bin"), home = join(root, "home"), cwd = join(root, "work");
    for (const dir of [bin, home, cwd]) mkdirSync(dir);
    writeFileSync(join(bin, "claude"), `#!/bin/sh
if [ "$1" = --help ]; then printf '%s\\n' '--permission-mode <mode> (choices: "auto", "default")'; exit 0; fi
printf '{"PLUGIN_DIRS":"%s","LEAKED":"%s"}' "\${CLAUDE_CODE_PLUGIN_DIRS-absent}" "\${LEAKED-absent}"
`);
    chmodSync(join(bin, "claude"), 0o700);
    const db = new Database(":memory:"); cleanup.push(() => { db.close(); });
    db.exec(`CREATE TABLE rigs(id TEXT, env_json TEXT);
      CREATE TABLE nodes(id TEXT, rig_id TEXT, runtime TEXT, cwd TEXT, env_json TEXT);
      CREATE TABLE bindings(id TEXT, node_id TEXT, tmux_session TEXT, tmux_pane TEXT);
      CREATE TABLE occupant_tenures(node_id TEXT, generation_uuid TEXT, generation_ordinal INTEGER);`);
    db.prepare("INSERT INTO rigs VALUES ('rig', NULL)").run();
    db.prepare("INSERT INTO nodes VALUES ('node', 'rig', 'claude-code', ?, ?)").run(cwd, opts.memberEnv ? JSON.stringify(opts.memberEnv) : null);
    db.exec("INSERT INTO bindings VALUES ('b', 'node', 'seat@rig', '%1'); INSERT INTO occupant_tenures VALUES ('node', 'gen', 1)");
    const managed = new RealManagedLaunch(db, { PATH: `${bin}:/usr/bin:/bin`, HOME: home }, {}, async () => undefined, opts.runtimeEnv);
    const run = async (command: string, paneEnv: Record<string, string>) => {
      const { stdout } = await exec("/bin/sh", ["-c", command], { env: { PATH: "/usr/bin:/bin", ...paneEnv }, timeout: 5000 });
      return JSON.parse(stdout) as Record<string, string>;
    };
    return { managed, run };
  }
  const target = { nodeId: "node", session: "seat@rig", pane: "%1" };
  const runtimeEnv = { "claude-code": { [PLUGIN_ENV]: VENDORED } };
  const launch = async (f: ReturnType<typeof fixture>) => (await f.managed.prepare(target, "auto")).command(["--permission-mode", "auto"]);

  it("gives a plain managed seat the vendored plugin, and still nothing else from the pane", async () => {
    const f = fixture({ runtimeEnv });
    const seen = await f.run(await launch(f), { LEAKED: "should-not-pass" });
    expect(seen).toEqual({ PLUGIN_DIRS: VENDORED, LEAKED: "absent" });
  });

  it("gives a seat that declared its own list the composed list from its pane, once", async () => {
    const f = fixture({ runtimeEnv, memberEnv: { [PLUGIN_ENV]: OWN_LIST } });
    const seen = await f.run(await launch(f), { [PLUGIN_ENV]: `${OWN_LIST}:${VENDORED}` });
    expect(seen.PLUGIN_DIRS).toBe(`${OWN_LIST}:${VENDORED}`);
  });

  it("is read at each launch, so a plugin vendored after the launcher was built still reaches the seat", async () => {
    const late: Record<string, Record<string, string>> = {};
    const f = fixture({ runtimeEnv: late });
    expect((await f.run(await launch(f), {})).PLUGIN_DIRS).toBe("absent");
    late["claude-code"] = { [PLUGIN_ENV]: VENDORED };
    expect((await f.run(await launch(f), {})).PLUGIN_DIRS).toBe(VENDORED);
  });

  it("changes nothing for a seat when no plugin is vendored", async () => {
    const f = fixture({});
    const command = await launch(f);
    expect(command).not.toContain(PLUGIN_ENV);
    expect((await f.run(command, {})).PLUGIN_DIRS).toBe("absent");
  });
});

describe("the plugin's activity relay", () => {
  const relayPath = require.resolve("../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs");
  let server: Server;
  let posts: Array<{ url: string; body: string }>;
  let port: number;
  let project: string;

  beforeEach(async () => {
    posts = [];
    project = mkdtempSync(join(tmpdir(), "claude-core-relay-"));
    mkdirSync(join(project, ".claude"), { recursive: true });
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => { posts.push({ url: req.url ?? "", body }); res.end("{}"); });
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    port = (server.address() as { port: number }).port;
  });
  afterEach(async () => { await new Promise<void>((ok) => server.close(() => ok())); rmSync(project, { recursive: true, force: true }); });

  const settingsWithRelay = (events: string[]) => JSON.stringify({
    hooks: Object.fromEntries(events.map((e) => [e, [{ hooks: [{ type: "command", command: `node '${SETTINGS_RELAY}'` }] }]])),
  });

  function run(payload: Record<string, unknown>, args: string[] = []): Promise<void> {
    return new Promise((done, fail) => {
      const child = spawn(process.execPath, [relayPath, ...args], {
        env: { PATH: process.env.PATH ?? "", OPENRIG_SESSION_NAME: "dev-claude@rig", OPENRIG_NODE_ID: "node-1", OPENRIG_RUNTIME: "claude-code",
          OPENRIG_URL: `http://127.0.0.1:${port}`, OPENRIG_ACTIVITY_HOOK_TOKEN: "tok", CLAUDE_PROJECT_DIR: project },
        stdio: ["pipe", "ignore", "ignore"],
      });
      child.on("error", fail);
      child.on("close", () => done());
      child.stdin.end(JSON.stringify(payload));
    });
  }

  it("reports as the plugin's copy when the seat has no settings relay (the resource is optional)", async () => {
    await run({ hook_event_name: "UserPromptSubmit", session_id: "s-1" }, ["--from-plugin"]);
    expect(posts.map((p) => p.url)).toEqual(["/api/activity/hooks"]);
    writeFileSync(join(project, ".claude", "settings.local.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] } }));
    await run({ hook_event_name: "UserPromptSubmit", session_id: "s-1" }, ["--from-plugin"]);
    expect(posts).toHaveLength(2);
  });

  it("reports a session start and its identity as the plugin's copy when nothing registers the settings relay", async () => {
    await run({ hook_event_name: "SessionStart", session_id: "s-1", source: "startup" }, ["--from-plugin"]);
    expect(posts.map((p) => p.url)).toEqual(["/api/activity/hooks", "/api/activity/hooks"]);
  });

  it("stays quiet as the plugin's copy for exactly the events the settings relay is registered for", async () => {
    writeFileSync(join(project, ".claude", "settings.local.json"), settingsWithRelay(["SessionStart", "UserPromptSubmit"]));
    await run({ hook_event_name: "SessionStart", session_id: "s-1", source: "startup" }, ["--from-plugin"]);
    await run({ hook_event_name: "UserPromptSubmit", session_id: "s-1" }, ["--from-plugin"]);
    expect(posts).toEqual([]);
    await run({ hook_event_name: "Stop", session_id: "s-1" }, ["--from-plugin"]);
    expect(posts.map((p) => p.url)).toEqual(["/api/activity/hooks"]);
  });

  it("reports when the settings file can't be read, so an unreadable file never leaves a seat silent", async () => {
    writeFileSync(join(project, ".claude", "settings.local.json"), "{ not json");
    await run({ hook_event_name: "UserPromptSubmit", session_id: "s-1" }, ["--from-plugin"]);
    expect(posts).toHaveLength(1);
  });

  it("always reports as the settings copy, the same script started without --from-plugin", async () => {
    writeFileSync(join(project, ".claude", "settings.local.json"), settingsWithRelay(["UserPromptSubmit"]));
    await run({ hook_event_name: "UserPromptSubmit", session_id: "s-1" });
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
