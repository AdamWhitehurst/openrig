import { existsSync } from "node:fs";
import { join } from "node:path";

// The env a Claude seat starts with so it loads the vendored openrig-core plugin (its refocus, compaction-restore
// and activity hooks). Claude reads CLAUDE_CODE_PLUGIN_DIRS, a colon-separated list, so this has to be the vendored
// copy under the OpenRig home: the copy projected into a seat's folder is named `shared:openrig-core`, and the
// colon splits it in two. It is an env var, not a launch argument, so the seat's process identity is unchanged.
//
// The plugin also carries an activity relay, and a seat's settings.local.json already has OpenRig's own copy of it.
// Both would post every event, so the seat is told the settings copy reports activity and the plugin's stays quiet.

export const CLAUDE_PLUGIN_DIRS_ENV = "CLAUDE_CODE_PLUGIN_DIRS";
export const ACTIVITY_HOOKS_OWNED_BY_SETTINGS_ENV = "OPENRIG_ACTIVITY_HOOKS_OWNED_BY_SETTINGS";

/** The Claude session env for the vendored plugin under `pluginsDir`, or undefined when it is not vendored. */
export function claudeCorePluginEnv(pluginsDir: string): Record<string, string> | undefined {
  const dir = join(pluginsDir, "openrig-core");
  if (!existsSync(join(dir, ".claude-plugin", "plugin.json"))) return undefined;
  return { [CLAUDE_PLUGIN_DIRS_ENV]: dir, [ACTIVITY_HOOKS_OWNED_BY_SETTINGS_ENV]: "1" };
}
