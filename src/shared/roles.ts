// The single source of truth for pipeline roles (SPEC-ROUTING §1). Every role enum, zod
// schema, settings dropdown, and planner prompt derives from PIPELINE_ROLES here, so adding
// a role (e.g. Phase-2's tester/documentor) is a one-line change instead of a ~11-site sweep.
//
// Deliberately NOT 1:1 with the north-star phases: Integration is the Tower itself (a
// deterministic controller — missions/worktrees/land — not a routed LLM role), and `docs` is
// an additional routed role from the brief's own list.

export const PIPELINE_ROLES = [
  { id: 'explore', label: 'Explore', hint: 'survey the code / gather context' },
  { id: 'plan', label: 'Plan', hint: 'design the change' },
  { id: 'implement', label: 'Implement', hint: 'write the code' },
  { id: 'review-judge', label: 'Review', hint: 'judge / grade the work' },
  { id: 'docs', label: 'Docs', hint: 'write documentation' },
  { id: 'tester', label: 'Tester', hint: 'author & run the e2e suite' },
] as const;

export type PipelineRole = (typeof PIPELINE_ROLES)[number]['id'];

// Tuple-typed so `z.enum(ROLE_IDS)` infers the literal union rather than `string` — a plain
// string[] would type-erase every schema derived from the registry (SPEC-ROUTING §1).
export const ROLE_IDS = PIPELINE_ROLES.map((r) => r.id) as unknown as [PipelineRole, ...PipelineRole[]];
