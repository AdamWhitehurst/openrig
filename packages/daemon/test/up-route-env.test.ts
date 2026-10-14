import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

const SPEC = `
version: "0.2"
name: env-flag-rig
pods:
  - id: dev
    label: Dev
    members:
      - id: impl
        agent_ref: "local:agents/impl"
        profile: default
        runtime: claude-code
        cwd: .
    edges: []
edges: []
`.trim();

const tmpDirs: string[] = [];
afterEach(() => { for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function setup() {
  const db = createFullTestDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "up-env-"));
  tmpDirs.push(dir);
  const specPath = path.join(dir, "rig.yaml");
  fs.writeFileSync(specPath, SPEC);
  const app = createTestApp(db, {
    upRouterFsOps: {
      exists: (p: string) => fs.existsSync(p),
      readFile: (p: string) => fs.readFileSync(p, "utf-8"),
      readHead: (p: string, n: number) => fs.readFileSync(p).subarray(0, n),
    },
  });
  const post = (body: Record<string, unknown>) => app.app.request("/api/up", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceRef: specPath, ...body }),
  });
  return { db, app, specPath, post };
}

describe("POST /api/up envOverride", () => {
  it.each([
    ["a reserved name", { OPENRIG_URL: "http://elsewhere" }, "reserved"],
    ["a lowercase name", { lower: "x" }, "not a valid name"],
    ["a non-string value", { COUNT: 3 }, "must be a string"],
  ])("refuses %s before anything launches", async (_label, envOverride, fragment) => {
    const { db, app, post } = setup();
    const bootstrap = vi.spyOn(app.bootstrapOrchestrator, "bootstrap");
    const res = await post({ envOverride });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("invalid_env");
    expect(body.error).toContain(fragment);
    expect(bootstrap).not.toHaveBeenCalled();
    db.close();
  });

  it("hands a valid override to the launch", async () => {
    const { db, app, post } = setup();
    const bootstrap = vi.spyOn(app.bootstrapOrchestrator, "bootstrap").mockResolvedValue({
      runId: "run", status: "completed", rigId: "rig", stages: [], errors: [],
    } as never);
    const res = await post({ envOverride: { DEBUG: "1" } });
    expect(res.status).toBe(201);
    expect(bootstrap).toHaveBeenCalledWith(expect.objectContaining({ mode: "apply", envOverride: { DEBUG: "1" } }));
    db.close();
  });

  it("says --env does not apply when the source is an existing rig", async () => {
    const { db, app } = setup();
    app.rigRepo.createRig("already-here");
    const res = await app.app.request("/api/up", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: "already-here", envOverride: { DEBUG: "1" } }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("env_not_applicable");
    db.close();
  });
});
