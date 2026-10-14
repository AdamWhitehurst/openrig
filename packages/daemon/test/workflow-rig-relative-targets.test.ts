import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { WorkflowSpecCache } from "../src/domain/workflow-spec-cache.js";
import { SliceIndexer } from "../src/domain/slices/slice-indexer.js";
import { SliceDetailProjector } from "../src/domain/slices/slice-detail-projector.js";
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
        - ops-watcher@{rig}
    finisher:
      preferred_targets:
        - ops-finisher@{rig}
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
        - ops-watcher@rig-a
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
      .run(`n-${id}`, id, `ops.${member}`, runtimeName);
    db.prepare(`INSERT INTO sessions (id, node_id, session_name, status) VALUES (?, ?, ?, 'running')`)
      .run(`s-${id}`, `n-${id}`, `ops-${member}@${name}`);
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

  it("--rig A resolves ops-watcher@{rig} to ops-watcher@rig-a", async () => {
    const r = await instantiate(relativePath, "rig-a");
    expect(entryOwner(r.instance.instanceId)).toBe("ops-watcher@rig-a");
  });

  it("--rig B resolves the same spec to ops-watcher@rig-b, a terminal member", async () => {
    const r = await instantiate(relativePath, "rig-b");
    expect(entryOwner(r.instance.instanceId)).toBe("ops-watcher@rig-b");
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
    expect(entryOwner(unbound.instance.instanceId)).toBe("ops-watcher@rig-a");
    const bound = await instantiate(literalPath, "rig-b");
    expect(entryOwner(bound.instance.instanceId)).toBe("ops-watcher@rig-a");
  });

  it("later hops use the bound rig too (the stored binding drives every read)", async () => {
    const r = await instantiate(relativePath, "rig-b");
    db.prepare(`INSERT INTO nodes (id, rig_id, logical_id, runtime) VALUES ('n-f', 'r-b', 'ops.finisher', 'claude-code')`).run();
    db.prepare(`INSERT INTO sessions (id, node_id, session_name, status) VALUES ('s-f', 'n-f', 'ops-finisher@rig-b', 'running')`).run();
    const packetId = r.instance.currentFrontier[0] ?? (db.prepare(`SELECT qitem_id FROM queue_items LIMIT 1`).get() as { qitem_id: string }).qitem_id;
    const projected = await runtime.project({
      instanceId: r.instance.instanceId,
      currentPacketId: packetId,
      exit: "handoff",
      actorSession: "ops-watcher@rig-b",
      resultNote: "next",
    } as never);
    const next = (projected as { nextOwnerSession?: string | null }).nextOwnerSession;
    expect(next).toBe("ops-finisher@rig-b");
  });

  it("validate on an unbound spec says a {rig} exception target resolves at instantiate, not 'unregistered'", () => {
    const specPath = join(tmp, "exception.yaml");
    writeFileSync(specPath, SPEC_RIG_RELATIVE + "  exception_routing:\n    orchestrator_role: watcher\n");
    const { exceptionReadiness } = runtime.validate(specPath);
    expect(exceptionReadiness.routes.length).toBeGreaterThan(0);
    for (const route of exceptionReadiness.routes) {
      expect(route.destinationSession).toBe("ops-watcher@{rig}");
      expect(route.identity).not.toBe("unregistered");
      expect(route.state).toBe("ready");
      expect(route.message).toMatch(/resolves at instantiate against the bound rig/);
    }
  });

  // --- instance reads: each path below reads the spec for a bound instance ---

  const SPEC_FAILABLE = `workflow:
  id: rig-relative-failable
  version: 1
  objective: a failed step re-resolves a {rig} target on resume
  entry:
    role: watcher
  roles:
    watcher:
      preferred_targets:
        - ops-watcher@{rig}
  steps:
    - id: watch
      actor_role: watcher
      allowed_exits:
        - handoff
        - failed
        - done
  exception_routing:
    orchestrator_role: watcher
`;

  function failedInstance(targetRig: string) {
    const specPath = join(tmp, "failable.yaml");
    writeFileSync(specPath, SPEC_FAILABLE);
    return instantiate(specPath, targetRig).then(async (r) => {
      const packetId = r.instance.currentFrontier[0]!;
      await runtime.project({
        instanceId: r.instance.instanceId,
        currentPacketId: packetId,
        exit: "failed",
        actorSession: `ops-watcher@${targetRig}`,
        resultNote: "boom",
      });
      return { instanceId: r.instance.instanceId, packetId };
    });
  }

  it("resume re-resolves the failed step's {rig} target on the bound rig", async () => {
    const { instanceId } = await failedInstance("rig-b");
    const resumed = await runtime.resume({ instanceId, actorSession: "orch@orch" });
    expect(resumed.ownerSession).toBe("ops-watcher@rig-b");
  });

  it("an unmapped failure's exception item goes to the {rig} target on the bound rig", async () => {
    const { instanceId } = await failedInstance("rig-b");
    const row = db.prepare(`SELECT destination_session FROM queue_items WHERE json_valid(tags)
      AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = 'workflow-exception')
      AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)`).get(`instance:${instanceId}`) as { destination_session: string } | undefined;
    expect(row?.destination_session).toBe("ops-watcher@rig-b");
  });

  it("resolveExceptionRouteFor expands {rig} with the instance's bound rig", async () => {
    await failedInstance("rig-a");
    const route = runtime.resolveExceptionRouteFor("rig-relative-failable", "1", "unmapped_failed", "rig-b");
    expect(route?.destinationSession).toBe("ops-watcher@rig-b");
  });

  it("exceptionReadiness reads the bound instance's target, not the literal {rig}", async () => {
    const { instanceId } = await failedInstance("rig-b");
    const readiness = runtime.exceptionReadiness(instanceId)!;
    for (const route of readiness.routes) {
      expect(route.destinationSession).toBe("ops-watcher@rig-b");
      expect(route.identity).toBe("declared-member");
    }
  });

  it("route re-targets a {rig} instance's frontier packet", async () => {
    const r = await instantiate(relativePath, "rig-b");
    const routed = await runtime.route({
      instanceId: r.instance.instanceId, toSession: "other@orch", actorSession: "orch@orch", reason: "move",
    });
    expect(routed.fromSession).toBe("ops-watcher@rig-b");
    expect(routed.toSession).toBe("other@orch");
  });

  it("abort closes a {rig} instance and records the step's role", async () => {
    const r = await instantiate(relativePath, "rig-b");
    const aborted = await runtime.abort({ instanceId: r.instance.instanceId, reason: "stop", actorSession: "orch@orch" });
    expect(aborted.status).toBe("aborted");
    const trail = db.prepare(`SELECT step_role FROM workflow_step_trails WHERE instance_id = ?`).get(r.instance.instanceId) as { step_role: string };
    expect(trail.step_role).toBe("watcher");
  });

  it("an unknown spec-default target.rig leaves the instance unbound, so a {rig} spec is refused", async () => {
    const specPath = join(tmp, "default-unknown.yaml");
    writeFileSync(specPath, SPEC_RIG_RELATIVE.replace("  entry:", "  target:\n    rig: vanished-rig\n  entry:"));
    await expect(instantiate(specPath)).rejects.toMatchObject({ code: "rig_placeholder_unbound" });
    const n = db.prepare(`SELECT COUNT(*) AS c FROM workflow_instances`).get() as { c: number };
    expect(n.c).toBe(0);
  });

  it("the slice view of a bound instance shows the seat the packet went to, not the literal {rig}", async () => {
    const sliceRoot = join(tmp, "slices");
    mkdirSync(join(sliceRoot, "rr-slice"), { recursive: true });
    writeFileSync(join(sliceRoot, "rr-slice", "README.md"), "---\nslice: rr-slice\nrail-item: PL-test\nstatus: active\n---\n# rr-slice\n");
    const r = await runtime.instantiate({ specPath: relativePath, rootObjective: "rr-slice work", createdBySession: "orch@orch", targetRig: "rig-b" });
    const indexer = new SliceIndexer({ slicesRoot: sliceRoot, dogfoodEvidenceRoot: null, db });
    const projector = new SliceDetailProjector({ db, indexer, workflowSpecCache: new WorkflowSpecCache(db) });
    const detail = projector.project(indexer.get("rr-slice")!);
    expect(detail.workflowBinding?.instanceId).toBe(r.instance.instanceId);
    expect(detail.topology.specGraph?.nodes.find((n) => n.role === "watcher")?.preferredTarget).toBe("ops-watcher@rig-b");
  });

  it("an occurrence-local resume (dependency graph) re-resolves the {rig} target too", async () => {
    const specPath = join(tmp, "graph.yaml");
    writeFileSync(specPath, `workflow:
  id: rig-relative-graph
  version: 1
  entry: {role: watcher}
  roles:
    watcher:
      preferred_targets:
        - ops-watcher@{rig}
  exception_routing: {orchestrator_role: watcher}
  steps:
    - id: root
      actor_role: watcher
      depends_on: []
      allowed_exits: [done, failed]
    - id: left
      actor_role: watcher
      depends_on: [root]
      allowed_exits: [done, failed]
    - id: right
      actor_role: watcher
      depends_on: [root]
      allowed_exits: [done, failed]
`);
    const started = await instantiate(specPath, "rig-b");
    const instanceId = started.instance.instanceId;
    await runtime.project({ instanceId, currentPacketId: started.entryQitemId, actorSession: "ops-watcher@rig-b", exit: "done" });
    const left = runtime.inspect(instanceId).frontier.find((p) => p.stepId === "left")!.packetId;
    await runtime.project({ instanceId, currentPacketId: left, actorSession: "ops-watcher@rig-b", exit: "failed", resultNote: "boom" });
    expect(runtime.inspect(instanceId).failures).toHaveLength(1);
    const resumed = await runtime.resume({ instanceId, occurrenceId: left, actorSession: "orch@orch" });
    expect(resumed.ownerSession).toBe("ops-watcher@rig-b");
  });
});
