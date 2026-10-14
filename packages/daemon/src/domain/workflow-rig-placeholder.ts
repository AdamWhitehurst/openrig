import type { WorkflowSpec } from "./workflow-types.js";

/**
 * A role's `preferred_targets` entry may be written `member@{rig}`. `{rig}`
 * stands for the instance's bound rig (`--rig`), so one reusable spec
 * addresses the same member on whichever rig it is run against.
 *
 * The cached spec keeps the literal `{rig}`; the expansion is computed from
 * the instance's stored `bound_rig` wherever that instance's spec is read,
 * so projection, resume, recovery and exception routing all see one target.
 */
export const RIG_PLACEHOLDER = "{rig}";

/** Roles whose preferred_targets use `{rig}`, in declaration order. */
export function rolesUsingRigPlaceholder(spec: WorkflowSpec): string[] {
  return Object.entries(spec.roles ?? {})
    .filter(([, role]) => (role?.preferred_targets ?? []).some((t) => t.includes(RIG_PLACEHOLDER)))
    .map(([name]) => name);
}

/** The spec with `{rig}` replaced by `boundRig`. Returns `spec` itself when it
 *  uses no placeholder, or when `boundRig` is null (nothing to resolve against). */
export function bindSpecToRig(spec: WorkflowSpec, boundRig: string | null): WorkflowSpec {
  if (boundRig === null || rolesUsingRigPlaceholder(spec).length === 0) return spec;
  const roles: NonNullable<WorkflowSpec["roles"]> = {};
  for (const [name, role] of Object.entries(spec.roles ?? {})) {
    roles[name] = role?.preferred_targets
      ? { ...role, preferred_targets: role.preferred_targets.map((t) => t.split(RIG_PLACEHOLDER).join(boundRig)) }
      : role;
  }
  return { ...spec, roles };
}
