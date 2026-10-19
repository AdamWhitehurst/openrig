import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { ContextMonitor } from "../src/domain/context-monitor.js";
import { ContextUsageStore } from "../src/domain/context-usage-store.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import { name, recordRotation, rotatedToken, rotation, rowsWith, seat, token } from "./helpers/claude-sweeper-seat.js";

// #1477 section 2 at the context monitor's tick: a Claude seat left in attention after a daemon restart,
// on an auto-mode screen with no banner, is promoted when the seat's real binding and resume token prove it.
describe("ContextMonitor proves a banner-less auto-mode Claude with no launch record", () => {
  let db: Database.Database;
  let registry: SessionRegistry;
  let repo: RigRepository;
  let home: string;
  beforeEach(() => {
    db = createFullTestDb(); registry = new SessionRegistry(db); repo = new RigRepository(db);
    home = mkdtempSync(join(tmpdir(), "sweeper-proof-"));
  });
  afterEach(() => { db.close(); rmSync(home, { recursive: true, force: true }); });

  function seed(status: "failed" | "attention_required", recordedToken: string | null = token) {
    const rig = repo.createRig("rig");
    const node = repo.addNode(rig.id, "seat", { runtime: "claude-code" });
    const session = registry.registerSession(node.id, name);
    registry.updateStatus(session.id, "running");
    registry.updateStartupStatus(session.id, status);
    if (recordedToken) registry.updateResumeToken(session.id, "claude_id", recordedToken);
    registry.updateBinding(node.id, { tmuxSession: name, tmuxPane: "%1" });
    return { rig, node, session };
  }
  const monitorWith = (checkReady: (binding: NodeBinding, opts?: { resumeToken?: string | null }) => Promise<{ ready: boolean }>) =>
    new ContextMonitor(db, new ContextUsageStore(db, { stateDir: home, codexHomeDir: home }), undefined, undefined, { "claude-code": { checkReady } as never });
  const status = (id: string) => (db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(id) as { startup_status: string }).startup_status;
  const eventCount = () => (db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;

  it.each(["failed", "attention_required"] as const)("promotes a %s seat on its tick, writing no event", async from => {
    const { session } = seed(from);
    const { adapter } = seat();
    const events = eventCount();
    await monitorWith((binding, opts) => adapter.checkReady(binding, opts)).pollOnce();
    expect(status(session.id)).toBe("ready");
    expect(eventCount()).toBe(events);
  });

  it("passes the seat's real binding and its recorded resume token", async () => {
    const { node, session } = seed("attention_required");
    const check = vi.fn(async () => ({ ready: false }));
    await monitorWith(check).pollOnce();
    expect(check).toHaveBeenCalledTimes(1);
    const [binding, options] = check.mock.calls[0] as unknown as [NodeBinding, { resumeToken?: string }];
    expect(binding).toMatchObject({ nodeId: node.id, tmuxSession: name, tmuxPane: "%1", id: registry.getBindingForNode(node.id)!.id });
    expect(binding.launchGeneration).toBe((db.prepare("SELECT generation_uuid FROM occupant_tenures WHERE node_id = ? ORDER BY generation_ordinal DESC LIMIT 1").get(node.id) as { generation_uuid: string }).generation_uuid);
    expect(options).toEqual({ resumeToken: token });
    expect(status(session.id)).toBe("attention_required");
  });

  it("through the real adapter: promotes on the exact token, and leaves a wrong-conversation seat flagged", async () => {
    const good = seed("attention_required");
    const { adapter } = seat();
    await monitorWith((binding, opts) => adapter.checkReady(binding, opts)).pollOnce();
    expect(status(good.session.id)).toBe("ready");
    db.prepare("UPDATE sessions SET startup_status = 'attention_required' WHERE id = ?").run(good.session.id);
    const wrong = seat();
    wrong.set(rowsWith({ command: `/x/claude --permission-mode auto --resume other --name ${name}` }));
    const events = eventCount();
    await monitorWith((binding, opts) => wrong.adapter.checkReady(binding, opts)).pollOnce();
    expect(status(good.session.id)).toBe("attention_required");
    expect(eventCount()).toBe(events);
  });

  it("passes the rotation recorded with the token, and the real adapter promotes a rotated seat by it", async () => {
    const { session } = seed("attention_required", rotatedToken);
    recordRotation(db, session.id);
    const check = vi.fn(async () => ({ ready: false }));
    await monitorWith(check).pollOnce();
    expect(check.mock.calls[0]![1]).toEqual({ resumeToken: rotatedToken, resumeRotation: rotation });
    const { adapter } = seat();
    await monitorWith((binding, opts) => adapter.checkReady(binding, opts)).pollOnce();
    expect(status(session.id)).toBe("ready");
  });

  it("leaves a rotated seat flagged when the process is not the one that recorded the rotation", async () => {
    const { session } = seed("attention_required", rotatedToken);
    recordRotation(db, session.id);
    const { adapter, set } = seat();
    set(rowsWith({ pid: 103 }));
    await monitorWith((binding, opts) => adapter.checkReady(binding, opts)).pollOnce();
    expect(status(session.id)).toBe("attention_required");
  });

  it("passes no options when the session records no token", async () => {
    seed("attention_required", null);
    const check = vi.fn(async () => ({ ready: false }));
    await monitorWith(check).pollOnce();
    expect(check.mock.calls[0]).toHaveLength(1);
  });
});
