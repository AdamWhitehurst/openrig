# openrig-core

Canonical OpenRig skills and hooks for cross-runtime agent topology coordination, continuity, and operating discipline.

## What this plugin ships

**Skills (19):** canonical OpenRig operating knowledge, including the public `refocusing` skill and
its path-only topology/work trace.

**Hooks:** activity tracking, compaction continuity, and the default-on refocus channel. Refocus is
post-compaction on both runtimes, threshold-triggered on Claude, on-demand on both, configurable
off, and never runs at fresh session start.

## Runtimes

This plugin ships dual-manifest packaging — both `.claude-plugin/` and `.codex-plugin/`.

- **Claude Code** — the OpenRig daemon vendors `openrig-core/` to `~/.openrig/plugins/openrig-core/` at startup and starts
  every Claude seat it launches with `CLAUDE_CODE_PLUGIN_DIRS` pointing at that copy, so the plugin's hooks (refocus,
  compaction restore) load with no setup step. This applies to fresh launches, restores and handover successors; a seat that
  was already running picks it up at its next launch. The seat's own `settings.local.json` already reports activity, so the
  daemon also sets `OPENRIG_ACTIVITY_HOOKS_OWNED_BY_SETTINGS=1` and the plugin's own `activity-relay.cjs` run (the manifest starts it with
  `--from-plugin`) exits for that seat. Outside OpenRig-launched seats nothing sets that variable, and the relay reports as before. The plugin is not a
  Claude marketplace entry, so `/plugin` has nothing to install.
- **Codex CLI** — Codex has no directory option for plugins, so it does not load this plugin. A Codex seat gets only the hooks
  the daemon writes into Codex's `config.toml` (the activity relay); `hooks/codex.json` is not read.

One skill targets Claude Code's compaction behavior specifically:
- `claude-compaction-restore` — used to rebuild a Claude Code agent's working mental model after `/compact`, from JSONL transcripts and touched files

This is NOT Codex-self-targeting (Codex's compaction is handled internally and doesn't need rebuild SOPs). But Codex agents acting as orchestrators frequently invoke this skill when restoring a peer Claude that has compacted — that's exactly when it's needed. Both runtimes ship it.

All other skills are cross-runtime by design.

## Distribution

The npm package includes an offline baseline under the daemon's
`assets/plugins/openrig-core/`. The daemon resolves local plugin authority before
attempting a network fetch, using the configured OpenRig home (normally
`~/.openrig/plugins/openrig-core/` for the installed copy):

| Installed state | Local vendoring behavior |
| --- | --- |
| Absent | Seed the bundled plugin. |
| Older manifest version | Advance files from the newer bundled version. |
| Equal manifest version | Preserve installed content; executable modes may be reconciled on byte-identical files. |
| Newer manifest version | Preserve the installed copy. |

Version authority comes from the plugin manifests. An existing directory without
a manifest is left unchanged; invalid or disagreeing manifest versions are
reported rather than guessed. Updating the CLI therefore does not unconditionally
overwrite an equal/newer or independently managed plugin copy.

After local resolution, the daemon attempts the GitHub release endpoint for
`openrig-core.tar.gz` with a five-second timeout. This path currently fetches and
logs the response only: it does not extract the archive, compare its version, or
install its content. Fetch failures, including 404 and network errors, leave the
resolved local copy in place. A successful fetch also leaves it unchanged.
This describes the fetch implementation, not a claim that a release artifact is
currently available at the external repository.

## License

Apache License 2.0. See `LICENSE`.

## Source

- Plugin repo: https://github.com/mvschwarz/openrig-plugins
- OpenRig CLI: https://github.com/mvschwarz/openrig
