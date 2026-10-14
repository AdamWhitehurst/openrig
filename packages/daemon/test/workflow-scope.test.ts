// A workflow instance carries the project / mission / slice (and free-form tags)
// it works for, and stamps them on every packet it creates, so the Projects
// view's slice Queue tab (exact project:<id> + slice:<id> match) lists them.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { runWorkflowBootSweep } from "../src/domain/workflow-boot-sweep.js";
import { makeEnsureStuckExceptionItem } from "../src/domain/workflow-exception-escalation.js";
import { WORKFLOW_STEP_STUCK_THRESHOLD_SECONDS } from "../src/domain/workflow-deadline.js";
import { SliceIndexer } from "../src/domain/slices/slice-indexer.js";
import { normalizeWorkflowScope, workflowScopeTags, WorkflowScopeError } from "../src/domain/workflow-scope.js";
import { workflowRoutes } from "../src/routes/workflow.js";

const SCOPE = { project: "p1", mission: "m1", slice: "01-s1" };
const SCOPE_TAGS = ["project:p1", "mission:m1", "slice:01-s1"];

const PIPELINE = `workflow:
  id: scope-pipeline
  version: 1
  objective: scope fixture
  entry: { role: producer }
  roles:
    producer: { preferred_targets: [producer@rig] }
    reviewer: { preferred_targets: [reviewer@rig] }
    orch: { preferred_targets: [orch-lead@rig] }
  steps:
    - { id: produce, actor_role: producer, allowed_exits: [handoff, done, failed] }
    - { id: review, actor_role: reviewer, allowed_exits: [done, failed] }
  exception_routing: { orchestrator_role: orch }
`;

const GATED = PIPELINE.replace("id: scope-pipeline", "id: scope-gated").replace(
  "{ id: review, actor_role: reviewer, allowed_exits: [done, failed] }",
  "{ id: review, actor_role: reviewer, allowed_exits: [done, failed], gate: { target: human@host, summary: sign off, evidence_ref: proof/review.md } }",
);

const PARALLEL = `workflow:
  id: scope-parallel
  version: 1
  entry: { role: root }
  exception_routing: { default: orchestrator, orchestrator_role: root }
  roles:
    root: { preferred_targets: [root@rig] }
    left: { preferred_targets: [left@rig] }
    right: { preferred_targets: [right@rig] }
  steps:
    - { id: root, actor_role: root, allowed_exits: [done, failed] }
    - { id: left, actor_role: left, depends_on: [root], allowed_exits: [done, failed] }
    - { id: right, actor_role: right, depends_on: [root], allowed_exits: [done, failed] }
`;

describe("workflow scope tags", () => {
  let db: Database.Database;
  let runtime: WorkflowRuntime;
  let queueRepo: QueueRepository;
  let bus: EventBus;
  let tmp: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    bus = new EventBus(db);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
    queueRepo.attachOutbox(new OutboxHandler(db));
    runtime = new WorkflowRuntime({
      db,
      eventBus: bus,
      queueRepo,
      exceptionDial: { hostDefault: () => null, humanFallbackSeat: "human@host" },
    });
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "wf-scope-")));
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const spec = (text: string, name = "spec.yaml") => {
    const file = join(tmp, name);
    writeFileSync(file, text);
    return file;
  };
  const tagsOf = (qitemId: string): string[] =>
    JSON.parse((db.prepare(`SELECT tags FROM queue_items WHERE qitem_id = ?`).get(qitemId) as { tags: string }).tags);
  const allTags = (): string[][] =>
    (db.prepare(`SELECT tags FROM queue_items ORDER BY ts_created, qitem_id`).all() as Array<{ tags: string }>).map((r) => JSON.parse(r.tags));
  const instantiate = (path: string, scope?: Parameters<typeof normalizeWorkflowScope>[0]) =>
    runtime.instantiate({ specPath: path, rootObjective: "scope", createdBySession: "ops@rig", ...(scope ? { scope } : {}) });

  describe("normalizeWorkflowScope", () => {
    it("is null when nothing is set", () => {
      expect(normalizeWorkflowScope({})).toBeNull();
      expect(normalizeWorkflowScope({ tags: [] })).toBeNull();
    });

    it("keeps the flag-derived scope tags first, --tags after, duplicates collapsed", () => {
      const scope = normalizeWorkflowScope({ ...SCOPE, tags: ["slice:01-s1", "ticket-7", "ticket-7", "area:db"] })!;
      expect(scope).toEqual({ ...SCOPE, tags: ["ticket-7", "area:db"] });
      expect(workflowScopeTags(scope)).toEqual([...SCOPE_TAGS, "ticket-7", "area:db"]);
    });

    it("takes a scope key from --tags when no flag sets it", () => {
      expect(normalizeWorkflowScope({ tags: ["project:p1", "x"] })).toEqual({ project: "p1", tags: ["x"] });
    });

    it.each([
      "workflow", "handoff", "gate", "entry", "resume", "re-route", "workflow-exception",
      "workflow:foo", "instance:abc", "step:build", "exception:human_gate_trip", "occurrence:q-1", "recovery-for:q-1",
    ])("refuses the reserved tag %s", (tag) => {
      expect(() => normalizeWorkflowScope({ tags: [tag] })).toThrow(WorkflowScopeError);
    });

    it("refuses a --tags scope tag that contradicts a flag, and a second value of one scope key", () => {
      expect(() => normalizeWorkflowScope({ project: "p1", tags: ["project:q"] })).toThrow(/contradict/i);
      expect(() => normalizeWorkflowScope({ tags: ["slice:A", "slice:B"] })).toThrow(/slice/);
    });

    it("refuses malformed ids and tags the queue readers would split", () => {
      expect(() => normalizeWorkflowScope({ project: "../x" })).toThrow(WorkflowScopeError);
      expect(() => normalizeWorkflowScope({ slice: "a b" })).toThrow(WorkflowScopeError);
      expect(() => normalizeWorkflowScope({ tags: ["a,b"] })).toThrow(WorkflowScopeError);
      expect(() => normalizeWorkflowScope({ tags: ["has space"] })).toThrow(WorkflowScopeError);
      expect(() => normalizeWorkflowScope({ tags: ["project:"] })).toThrow(WorkflowScopeError);
    });
  });

  describe("stamping", () => {
    it("stamps the entry packet after the system tags, and persists the scope on the instance", async () => {
      const inst = await instantiate(spec(PIPELINE), { ...SCOPE, tags: ["ticket-7"] });
      expect(tagsOf(inst.entryQitemId)).toEqual([
        "workflow", "entry", "workflow:scope-pipeline", `instance:${inst.instance.instanceId}`,
        ...SCOPE_TAGS, "ticket-7",
      ]);
      expect(inst.instance.scope).toEqual({ ...SCOPE, tags: ["ticket-7"] });
      expect(runtime.instanceStore.getByIdOrThrow(inst.instance.instanceId).scope).toEqual({ ...SCOPE, tags: ["ticket-7"] });
    });

    it("stamps hand-off packets", async () => {
      const inst = await instantiate(spec(PIPELINE), SCOPE);
      const result = await runtime.project({
        instanceId: inst.instance.instanceId, currentPacketId: inst.entryQitemId, exit: "handoff", actorSession: "producer@rig",
      });
      expect(tagsOf(result.nextQitemId!)).toEqual([
        "workflow", "handoff", "workflow:scope-pipeline", `instance:${inst.instance.instanceId}`, ...SCOPE_TAGS,
      ]);
    });

    it("stamps parallel hand-off packets after their step: tag", async () => {
      const inst = await instantiate(spec(PARALLEL), SCOPE);
      await runtime.project({ instanceId: inst.instance.instanceId, currentPacketId: inst.entryQitemId, exit: "done", actorSession: "root@rig" });
      const branches = runtime.inspect(inst.instance.instanceId).frontier;
      expect(branches).toHaveLength(2);
      for (const branch of branches) {
        expect(tagsOf(branch.packetId)).toEqual([
          "workflow", "handoff", "workflow:scope-parallel", `instance:${inst.instance.instanceId}`, `step:${branch.stepId}`, ...SCOPE_TAGS,
        ]);
      }
    });

    it("stamps a gate packet, after its exception identity tags", async () => {
      const inst = await instantiate(spec(GATED), { ...SCOPE, tags: ["ticket-7"] });
      const result = await runtime.project({
        instanceId: inst.instance.instanceId, currentPacketId: inst.entryQitemId, exit: "handoff", actorSession: "producer@rig",
      });
      const tags = tagsOf(result.nextQitemId!);
      expect(tags.slice(0, 2)).toEqual(["workflow", "gate"]);
      expect(tags).toContain("workflow-exception");
      expect(tags.slice(-4)).toEqual([...SCOPE_TAGS, "ticket-7"]);
    });

    it("stamps an exception packet", async () => {
      const inst = await instantiate(spec(PIPELINE), SCOPE);
      await runtime.project({
        instanceId: inst.instance.instanceId, currentPacketId: inst.entryQitemId, exit: "failed", actorSession: "producer@rig",
      });
      const rows = db.prepare(`SELECT qitem_id FROM queue_items WHERE tags LIKE '%workflow-exception%'`).all() as Array<{ qitem_id: string }>;
      expect(rows).toHaveLength(1);
      const tags = tagsOf(rows[0]!.qitem_id);
      expect(tags).toContain("exception:unmapped_failed");
      expect(tags.slice(-3)).toEqual(SCOPE_TAGS);
    });

    it("stamps a gated entry packet", async () => {
      const entryGated = GATED.replace(
        "{ id: produce, actor_role: producer, allowed_exits: [handoff, done, failed] }",
        "{ id: produce, actor_role: producer, allowed_exits: [handoff, done, failed], gate: { target: human@host, summary: kickoff, evidence_ref: proof/k.md } }",
      );
      const inst = await instantiate(spec(entryGated), SCOPE);
      const tags = tagsOf(inst.entryQitemId);
      expect(tags.slice(0, 2)).toEqual(["workflow", "gate"]);
      expect(tags.slice(-3)).toEqual(SCOPE_TAGS);
    });

    it("stamps the stuck-overdue exception item", async () => {
      const inst = await instantiate(spec(PIPELINE), SCOPE);
      const past = new Date(Date.now() - (WORKFLOW_STEP_STUCK_THRESHOLD_SECONDS + 3600) * 1000).toISOString();
      db.prepare(`UPDATE queue_items SET ts_created = ? WHERE qitem_id = ?`).run(past, inst.entryQitemId);
      await runWorkflowBootSweep({
        instanceStore: runtime.instanceStore,
        queueRepo,
        watchdogJobsRepo: new WatchdogJobsRepository(db),
        ensureStuckExceptionItem: makeEnsureStuckExceptionItem({
          db, queueRepo, resolveRoute: (n, v, c) => runtime.resolveExceptionRouteFor(n, v, c), humanFallbackSeat: "human@host",
        }),
        reconcileStuckExceptions: () => runtime.reconcileStuckExceptions(),
      });
      const rows = db.prepare(`SELECT qitem_id FROM queue_items WHERE tags LIKE '%exception:stuck_overdue%'`).all() as Array<{ qitem_id: string }>;
      expect(rows).toHaveLength(1);
      expect(tagsOf(rows[0]!.qitem_id).slice(-3)).toEqual(SCOPE_TAGS);
    });

    it("stamps the resume packet after a failure is resumed", async () => {
      const inst = await instantiate(spec(PIPELINE), SCOPE);
      await runtime.project({
        instanceId: inst.instance.instanceId, currentPacketId: inst.entryQitemId, exit: "failed", actorSession: "producer@rig",
      });
      const resumed = await runtime.resume({ instanceId: inst.instance.instanceId, actorSession: "orch-lead@rig" });
      const packetId = (resumed as { redrivePacketId?: string; packetId?: string }).redrivePacketId
        ?? (resumed as { packetId?: string }).packetId
        ?? runtime.inspect(inst.instance.instanceId).frontier[0]!.packetId;
      expect(tagsOf(packetId)).toContain("resume");
      expect(tagsOf(packetId).slice(-3)).toEqual(SCOPE_TAGS);
    });

    it("leaves an unscoped instance's packets exactly as before", async () => {
      const inst = await instantiate(spec(PIPELINE));
      const result = await runtime.project({
        instanceId: inst.instance.instanceId, currentPacketId: inst.entryQitemId, exit: "handoff", actorSession: "producer@rig",
      });
      expect(inst.instance.scope).toBeNull();
      expect(tagsOf(inst.entryQitemId)).toEqual(["workflow", "entry", "workflow:scope-pipeline", `instance:${inst.instance.instanceId}`]);
      expect(tagsOf(result.nextQitemId!)).toEqual(["workflow", "handoff", "workflow:scope-pipeline", `instance:${inst.instance.instanceId}`]);
    });

    it("refuses reserved tags at instantiate, before any instance or packet exists", async () => {
      await expect(instantiate(spec(PIPELINE), { tags: ["instance:abc"] })).rejects.toBeInstanceOf(WorkflowScopeError);
      expect((db.prepare(`SELECT count(*) AS n FROM workflow_instances`).get() as { n: number }).n).toBe(0);
      expect(allTags()).toEqual([]);
    });
  });

  describe("lifecycle", () => {
    it("defaults project and mission from the recorded identity and tags each step's packets slice:<stepId>", async () => {
      const missionDir = join(tmp, "missions", "release-1.0.0");
      mkdirSync(join(missionDir, "slices", "01-build"), { recursive: true });
      mkdirSync(join(missionDir, "slices", "02-ship"), { recursive: true });
      writeFileSync(join(tmp, "project.yaml"), `kind: project\nmetadata: { id: demo }\nlifecycle: { profile: release }\n`);
      writeFileSync(join(missionDir, "mission.yaml"), `kind: mission\nmetadata: { name: release-1.0.0 }\ncomposition:\n  slices:\n    - { ref: slices/01-build/slice.yaml, order: 10 }\n    - { ref: slices/02-ship/slice.yaml, order: 20 }\n`);
      writeFileSync(join(missionDir, "slices", "01-build", "slice.yaml"), `kind: slice\nmetadata: { id: build }\ncomposition: { mission: ../../mission.yaml }\nexecution:\n  actor_role: builder\n  preferred_targets: [builder@rig]\n  allowed_exits: [handoff, done, failed]\n`);
      writeFileSync(join(missionDir, "slices", "02-ship", "slice.yaml"), `kind: slice\nmetadata: { id: ship }\ncomposition: { mission: ../../mission.yaml }\nexecution:\n  actor_role: shipper\n  preferred_targets: [shipper@rig]\n  depends_on: [build]\n  allowed_exits: [done, failed]\n`);
      const created = await runtime.instantiateLifecycle({
        missionPath: missionDir, operationKey: "scope-op-1", rootObjective: "lifecycle", createdBySession: "ops@rig",
      });
      expect(created.instance.scope).toEqual({ project: "demo", mission: "release-1.0.0" });
      expect(tagsOf(created.entryQitemId).slice(-3)).toEqual(["project:demo", "mission:release-1.0.0", "slice:build"]);
      const next = await runtime.project({
        instanceId: created.instance.instanceId, currentPacketId: created.entryQitemId, exit: "handoff", actorSession: "builder@rig",
      });
      expect(tagsOf(next.nextQitemId!).slice(-3)).toEqual(["project:demo", "mission:release-1.0.0", "slice:ship"]);
    });
  });

  describe("slice indexer", () => {
    it("lists a projected packet on the slice's Queue tab for its project, and not for another project", async () => {
      const slices = join(tmp, "slices-root");
      mkdirSync(join(slices, "01-s1"), { recursive: true });
      writeFileSync(join(slices, "01-s1", "README.md"), "# s1\n");
      const inst = await instantiate(spec(PIPELINE), SCOPE);
      const result = await runtime.project({
        instanceId: inst.instance.instanceId, currentPacketId: inst.entryQitemId, exit: "handoff", actorSession: "producer@rig",
      });
      const indexerFor = (projectId: string) => new SliceIndexer({ db, slicesRoot: slices, dogfoodEvidenceRoot: null, projectId });
      const own = indexerFor("p1").get("01-s1");
      expect(own?.qitemIds).toEqual(expect.arrayContaining([inst.entryQitemId, result.nextQitemId!]));
      expect(indexerFor("other").get("01-s1")?.qitemIds ?? []).toEqual([]);
    });
  });

  describe("HTTP", () => {
    const appFor = (catalogRoot: string) => {
      const app = new Hono();
      app.use("*", async (c, next) => {
        c.set("workflowRuntime" as never, runtime);
        c.set("eventBus" as never, bus);
        c.set("settingsStore" as never, {
          resolveOne: (key: string) => ({ value: key === "workspace.root" ? catalogRoot : join(catalogRoot, "workspace.yaml") }),
        });
        await next();
      });
      app.route("/api/workflow", workflowRoutes());
      return app;
    };
    const post = (app: Hono, body: Record<string, unknown>) =>
      app.request("/api/workflow/instantiate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    it("refuses a project the workspace catalog does not declare, and creates nothing", async () => {
      writeFileSync(join(tmp, "workspace.yaml"), "projects:\n  - id: p1\n    root: p1\n");
      mkdirSync(join(tmp, "p1", "missions"), { recursive: true });
      const response = await post(appFor(tmp), {
        specPath: spec(PIPELINE), rootObjective: "x", createdBySession: "ops@rig", project: "nope",
      });
      expect(response.status).toBe(409);
      expect((await response.json() as { error: string }).error).toBe("project_not_found");
      expect((db.prepare(`SELECT count(*) AS n FROM workflow_instances`).get() as { n: number }).n).toBe(0);
    });

    it("accepts a catalogued project and stamps it, with --tags", async () => {
      writeFileSync(join(tmp, "workspace.yaml"), "projects:\n  - id: p1\n    root: p1\n");
      mkdirSync(join(tmp, "p1", "missions"), { recursive: true });
      const response = await post(appFor(tmp), {
        specPath: spec(PIPELINE), rootObjective: "x", createdBySession: "ops@rig", project: "p1", slice: "01-s1", tags: ["ticket-7"],
      });
      expect(response.status).toBe(201);
      const body = await response.json() as { entryQitemId: string };
      expect(tagsOf(body.entryQitemId).slice(-3)).toEqual(["project:p1", "slice:01-s1", "ticket-7"]);
    });

    it("refuses a reserved tag with a 400", async () => {
      const response = await post(appFor(tmp), {
        specPath: spec(PIPELINE), rootObjective: "x", createdBySession: "ops@rig", tags: ["gate"],
      });
      expect(response.status).toBe(400);
      expect((await response.json() as { error: string }).error).toBe("scope_tag_reserved");
    });
  });
});
