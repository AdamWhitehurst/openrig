import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { WorkflowProjectorError } from "../src/domain/workflow-projector.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";

// A reusable workflow spec can write `member@{rig}` in preferred_targets;
// `{rig}` resolves to the instance's bound rig (--rig), so one spec
// addresses that rig's seat, including a terminal member.

const SPEC_RIG_RELATIVE = `workflow:
  id: rig-relative-targets
  version: 1
  objective: member@{rig} resolves against the bound rig
  entry:
    role: watcher
  roles:
    watcher:
      preferred_targets:
        - watcher@{rig}
    finisher:
      preferred_targets:
        - finisher@{rig}
  steps:
    - id: watch
      actor_role: watcher
      allowed_exits:
        - handoff
      next_hop:
        mode: require
        suggested_roles:
          - finisher
    - id: finish
      actor_role: finisher
      allowed_exits:
        - done
`;

const SPEC_LITERAL = `workflow:
  id: literal-targets
  version: 1
  objective: literal member@rig is unchanged
  entry:
    role: watcher
  roles:
    watcher:
      preferred_targets:
        - watcher@rig-a
  steps:
    - id: watch
      actor_role: watcher
      allowed_exits:
        - done
`;

describe("workflow preferred_targets: member@{rig}", () => {
  let db: Database.Database;
  let runtime: WorkflowRuntime;
  let tmp: string;
  let relativePath: string;
  let literalPath: string;

  function seedRig(id: string, name: string, member: string, runtimeName: string): void {
    db.prepare(`INSERT INTO rigs (id, name) VALUES (?, ?)`).run(id, name);
    db.prepare(`INSERT INTO nodes (id, rig_id, logical_id, runtime) VALUES (?, ?, ?, ?)`)
      .run(`n-${id}`, id, member, runtimeName);
    db.prepare(`INSERT INTO sessions (id, node_id, session_name, status) VALUES (?, ?, ?, 'running')`)
      .run(`s-${id}`, `n-${id}`, `${member}@${name}`);
  }

  function entryOwner(instanceId: string): string {
    const row = db.prepare(`SELECT destination_session FROM queue_items WHERE qitem_id = (
      SELECT json_extract(current_frontier_json, '$[0]') FROM workflow_instances WHERE instance_id = ?)`)
      .get(instanceId) as { destination_session: string } | undefined;
    expect(row).toBeDefined();
    return row!.destination_session;
  }

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    seedRig("r-a", "rig-a", "watcher", "claude-code");
    seedRig("r-b", "rig-b", "watcher", "terminal");
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-orch', 'orch')`).run();
    const bus = new EventBus(db);
    const queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
    queueRepo.attachOutbox(new OutboxHandler(db));
    runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo });
    tmp = mkdtempSync(join(tmpdir(), "wf-rigrel-"));
    relativePath = join(tmp, "relative.yaml");
    writeFileSync(relativePath, SPEC_RIG_RELATIVE);
    literalPath = join(tmp, "literal.yaml");
    writeFileSync(literalPath, SPEC_LITERAL);
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const instantiate = (specPath: string, targetRig?: string) =>
    runtime.instantiate({ specPath, rootObjective: "t", createdBySession: "orch@orch", ...(targetRig ? { targetRig } : {}) });

  it("--rig A resolves watcher@{rig} to watcher@rig-a", async () => {
    const r = await instantiate(relativePath, "rig-a");
    expect(entryOwner(r.instance.instanceId)).toBe("watcher@rig-a");
  });

  it("--rig B resolves the same spec to watcher@rig-b, a terminal member", async () => {
    const r = await instantiate(relativePath, "rig-b");
    expect(entryOwner(r.instance.instanceId)).toBe("watcher@rig-b");
  });

  it("refuses {rig} with no bound rig, before creating an instance", async () => {
    let thrown: unknown;
    try {
      await instantiate(relativePath);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(WorkflowProjectorError);
    const e = thrown as WorkflowProjectorError;
    expect(e.code).toBe("rig_placeholder_unbound");
    expect(e.message).toContain("{rig}");
    expect(e.message).toContain("--rig");
    const n = db.prepare(`SELECT COUNT(*) AS c FROM workflow_instances`).get() as { c: number };
    expect(n.c).toBe(0);
  });

  it("literal member@rig entries behave as before, bound or not", async () => {
    const unbound = await instantiate(literalPath);
    expect(entryOwner(unbound.instance.instanceId)).toBe("watcher@rig-a");
    const bound = await instantiate(literalPath, "rig-b");
    expect(entryOwner(bound.instance.instanceId)).toBe("watcher@rig-a");
  });

  it("later hops use the bound rig too (the stored binding drives every read)", async () => {
    const r = await instantiate(relativePath, "rig-b");
    db.prepare(`INSERT INTO nodes (id, rig_id, logical_id, runtime) VALUES ('n-f', 'r-b', 'finisher', 'claude-code')`).run();
    db.prepare(`INSERT INTO sessions (id, node_id, session_name, status) VALUES ('s-f', 'n-f', 'finisher@rig-b', 'running')`).run();
    const packetId = r.instance.currentFrontier[0] ?? (db.prepare(`SELECT qitem_id FROM queue_items LIMIT 1`).get() as { qitem_id: string }).qitem_id;
    const projected = await runtime.project({
      instanceId: r.instance.instanceId,
      currentPacketId: packetId,
      exit: "handoff",
      actorSession: "watcher@rig-b",
      resultNote: "next",
    } as never);
    const next = (projected as { nextOwnerSession?: string | null }).nextOwnerSession;
    expect(next).toBe("finisher@rig-b");
  });
});
