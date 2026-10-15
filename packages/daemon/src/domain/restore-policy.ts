/** The restore policy restore acts on for one saved seat.
 *
 *  A terminal has no conversation to resume. Its session rows still read `resume_if_possible`, the
 *  column default every session a relaunch creates takes (migration 006), and restore stops a
 *  `resume_if_possible` seat that has no token and asks for `--fresh`. Left alone, a terminal seat
 *  would wait for a decision on every restore after its first. So `resume_if_possible` means
 *  `relaunch_fresh` there; any other policy is read as saved. */
export function effectiveRestorePolicy(runtime: string | null | undefined, policy: string | null | undefined): string {
  const saved = policy ?? "resume_if_possible";
  return runtime === "terminal" && saved === "resume_if_possible" ? "relaunch_fresh" : saved;
}
