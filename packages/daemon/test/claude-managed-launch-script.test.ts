// #1477 section 1: a managed launch says whether the executable it froze is a `#!` script, so the
// proof of the launched process can allow for a wrapper that exec's the real binary. Drives the real
// ClaudeManagedLaunch.prepare() against private fake executables; no provider, tmux or daemon.
import { afterEach, expect, it } from "vitest";
import Database from "better-sqlite3";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ClaudeManagedLaunch } from "../src/domain/claude-managed-launch.js";

const HELP = '  --permission-mode <mode>   Permission mode to use for the session (choices: "acceptEdits", "auto", "default", "plan")';
const open: Database.Database[] = [];
afterEach(() => { for (const db of open.splice(0)) db.close(); });

// `file` is the exact bytes of `claude` on the daemon's PATH. A file with no #! line still runs (the
// shell takes it), so it stands in for anything that is not a script without needing a real binary.
async function prepared(file: string, link?: boolean) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "claude-script-launch-")));
  const cwd = path.join(root, "seat"); const bin = path.join(root, "bin");
  mkdirSync(cwd); mkdirSync(bin); mkdirSync(path.join(root, "home"));
  const target = path.join(link ? root : bin, link ? "real-claude" : "claude");
  writeFileSync(target, file); chmodSync(target, 0o755);
  if (link) symlinkSync(target, path.join(bin, "claude"));
  const db = new Database(":memory:"); open.push(db);
  db.exec(`CREATE TABLE nodes(id TEXT, runtime TEXT, cwd TEXT);
    CREATE TABLE bindings(id TEXT, node_id TEXT, tmux_session TEXT, tmux_pane TEXT);
    CREATE TABLE occupant_tenures(node_id TEXT, generation_uuid TEXT, generation_ordinal INTEGER);`);
  db.prepare("INSERT INTO nodes VALUES ('node','claude-code',?)").run(cwd);
  db.exec("INSERT INTO bindings VALUES ('binding','node','seat','%1'); INSERT INTO occupant_tenures VALUES ('node','generation-1',1)");
  const managed = new ClaudeManagedLaunch(db, { PATH: `${bin}:/usr/bin:/bin`, HOME: path.join(root, "home") }, {});
  return { managed: await managed.prepare({ nodeId: "node" }, "auto"), target };
}
const printsHelp = `printf '%s\\n' '${HELP}'\n`;

it("reports a frozen executable that starts with #! as a script", async () => {
  const { managed, target } = await prepared(`#!/bin/sh\n${printsHelp}`);
  expect(managed.executable).toBe(target);
  expect(managed.executableIsScript).toBe(true);
});

it("reports it through a symlink, whose realpath is the frozen executable", async () => {
  const { managed, target } = await prepared(`#!/bin/sh\n${printsHelp}`, true);
  expect(managed.executable).toBe(target);
  expect(managed.executableIsScript).toBe(true);
});

it("does not report a file that does not start with #!", async () => {
  // A leading blank line or space is not a shebang; the kernel only reads one at byte 0.
  expect((await prepared(`${printsHelp}`)).managed.executableIsScript).toBe(false);
  expect((await prepared(`\n#!/bin/sh\n${printsHelp}`)).managed.executableIsScript).toBe(false);
  expect((await prepared(` #!/bin/sh\n${printsHelp}`)).managed.executableIsScript).toBe(false);
});
