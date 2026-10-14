import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorkflowDeps } from "../src/commands/workflow.js";
import { createProgram } from "../src/index.js";

// `rig workflow instantiate|run --project/--mission/--slice/--tags`: the scope a
// run's packets carry, sent to the daemon as a `scope` object on BOTH verbs (run
// instantiates too). The object is what opts the request into the daemon's strict
// validation; bare fields keep their old meaning there (ignored). Unscoped
// invocations send no scope.

vi.mock("../src/daemon-lifecycle.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js");
  return {
    ...actual,
    getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1234, port: 7433 })),
    getDaemonUrl: vi.fn(() => "http://localhost:7433"),
  };
});

interface StubResponse {
  status: number;
  data: unknown;
}

function makeDeps(opts?: { routes?: Record<string, StubResponse> }): {
  deps: WorkflowDeps;
  calls: Array<{ method: string; path: string; body?: unknown }>;
} {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const routes = opts?.routes ?? {};
  return {
    calls,
    deps: {
      lifecycleDeps: {} as WorkflowDeps["lifecycleDeps"],
      clientFactory: () =>
        ({
          get: vi.fn(async (path: string) => {
            calls.push({ method: "GET", path });
            return routes[`GET ${path}`] ?? { status: 200, data: {} };
          }),
          getText: vi.fn(async (path: string) => {
            calls.push({ method: "GET", path });
            return { status: 200, data: "" };
          }),
          post: vi.fn(async (path: string, body: unknown) => {
            calls.push({ method: "POST", path, body });
            return routes[`POST ${path}`] ?? { status: 200, data: {} };
          }),
          delete: vi.fn(async (path: string) => {
            calls.push({ method: "DELETE", path });
            return { status: 204, data: null };
          }),
          postText: vi.fn(async (path: string) => {
            calls.push({ method: "POST", path });
            return { status: 200, data: "" };
          }),
          postExpectText: vi.fn(async (path: string) => {
            calls.push({ method: "POST", path });
            return { status: 200, data: "" };
          }),
        }) as unknown as ReturnType<WorkflowDeps["clientFactory"]>,
    },
  };
}

describe("workflow scope flags", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = undefined;
  });

  const run = async (verb: "instantiate" | "run", extra: string[]) => {
    const { deps, calls } = makeDeps({
      routes: { "POST /api/workflow/instantiate": { status: 201, data: { instance: {}, entryQitemId: "q-1" } } },
    });
    const program = createProgram({ workflowDeps: deps });
    program.exitOverride();
    await program.parseAsync(["node", "rig", "workflow", verb, "/abs/spec.yaml", "--root-objective", "obj", "--created-by", "ops@rig", "--json", ...extra]);
    return calls.find((c) => c.path === "/api/workflow/instantiate")!.body as Record<string, unknown>;
  };

  it.each(["instantiate", "run"] as const)("%s posts project, mission, slice and split tags", async (verb) => {
    const body = await run(verb, ["--project", "p1", "--mission", "m1", "--slice", "01-s1", "--tags", "ticket-7, area:db,"]);
    expect(body.scope).toEqual({ project: "p1", mission: "m1", slice: "01-s1", tags: ["ticket-7", "area:db"] });
    for (const key of ["project", "mission", "slice", "tags"]) expect(body).not.toHaveProperty(key);
  });

  it.each(["instantiate", "run"] as const)("%s sends only the flags given", async (verb) => {
    const body = await run(verb, ["--slice", "01-s1"]);
    expect(body.scope).toEqual({ slice: "01-s1" });
  });

  it.each(["instantiate", "run"] as const)("%s --slice help says the packets also need --project in a project-scoped view", (verb) => {
    const program = createProgram({ workflowDeps: makeDeps().deps });
    const command = program.commands.find((c) => c.name() === "workflow")!.commands.find((c) => c.name() === verb)!;
    const slice = command.options.find((o) => o.long === "--slice")!;
    expect(slice.description).toMatch(/--project/);
  });

  it.each(["instantiate", "run"] as const)("%s without scope flags sends none of the scope fields", async (verb) => {
    const body = await run(verb, []);
    for (const key of ["scope", "project", "mission", "slice", "tags"]) expect(body).not.toHaveProperty(key);
  });
});
