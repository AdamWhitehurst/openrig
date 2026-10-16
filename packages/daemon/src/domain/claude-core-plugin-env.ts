import { existsSync } from "node:fs";
import { join } from "node:path";

// The env a Claude seat starts with so it loads the vendored openrig-core plugin (its refocus, compaction-restore
// and activity hooks). Claude reads CLAUDE_CODE_PLUGIN_DIRS, a colon-separated list, so this has to be the vendored
// copy under the OpenRig home: the copy projected into a seat's folder is named `shared:openrig-core`, and the
// colon splits it in two. It is an env var, not a launch argument, so the seat's process identity is unchanged.
//
// A seat may declare its own CLAUDE_CODE_PLUGIN_DIRS (its spec's env, or a one-off `rig up --env`), applied after the
// per-runtime map. Its list keeps working and the vendored plugin is added to it, so nothing a seat set on main stops
// reaching Claude.
//
// The plugin also carries an activity relay, and a seat's settings.local.json may carry OpenRig's own copy of it. The
// plugin's relay run decides for itself, from that file, whether to stay quiet (see hooks/scripts/activity-relay.cjs).

export const CLAUDE_PLUGIN_DIRS_ENV = "CLAUDE_CODE_PLUGIN_DIRS";

/** The Claude session env for the vendored plugin under `pluginsDir`, or undefined when it is not vendored. */
export function claudeCorePluginEnv(pluginsDir: string): Record<string, string> | undefined {
  const dir = join(pluginsDir, "openrig-core");
  if (!existsSync(join(dir, ".claude-plugin", "plugin.json"))) return undefined;
  return { [CLAUDE_PLUGIN_DIRS_ENV]: dir };
}

/**
 * `env` is a seat's finished launch env and `runtimeEnv` the per-runtime map it was built from. When the seat's own
 * layers replaced the vendored plugin path, put it back after the seat's own list; otherwise `env` is returned as is.
 */
export function keepVendoredPluginDir(
  env: Record<string, string>,
  runtimeEnv: Record<string, string | undefined> | undefined,
): Record<string, string> {
  const vendored = runtimeEnv?.[CLAUDE_PLUGIN_DIRS_ENV];
  const own = env[CLAUDE_PLUGIN_DIRS_ENV];
  if (!vendored || own === vendored) return env;
  if (own === undefined) return { ...env, [CLAUDE_PLUGIN_DIRS_ENV]: vendored }; // a seat's empty value is dropped by the launch
  if (own.split(":").includes(vendored)) return env;
  return { ...env, [CLAUDE_PLUGIN_DIRS_ENV]: `${own}:${vendored}` };
}
