# Verified delivery workflow

Use this workflow for nontrivial repository changes that need auditable,
repeatable delivery evidence: parallel work, public contracts, data or
security boundaries, performance claims, reviewable migrations, and work that
will be handed off. It is optional for a microtask with one obvious file and a
focused check.

1. Record the requirement and acceptance criteria in a task envelope before
   editing. Include the checked baseline commit and the files that each slice
   may change. If the baseline is dirty, record the explicit authorization and
   why its existing changes are safe to preserve.
2. Map each requirement to affected files, contracts, and checks. Assign one
   owner per mutable boundary. Run independent discovery and validation in
   parallel only when their boundaries do not overlap.
3. Implement the smallest change that satisfies the mapped requirement.
   Record each executed check with its command, result, and baseline commit.
4. Review the actual diff independently. The review must cover requirement
   coverage, public contracts, security-sensitive paths, and regression risk.
5. Record dependencies, unknowns, and stop conditions when they affect a
   slice. A changed dependency, contract, baseline, or owned file invalidates
   dependent evidence; stop, record the invalidation, and re-plan that slice.
6. Re-run checks whose baseline or affected boundary changed. Deliver only
   when every required check and review entry is passed, or when an explicit
   residual risk records why a check is not verified.

The task envelope follows task-envelope.schema.json. Add provenance entries
for durable evidence and reference them from each acceptance criterion. Do not
put credentials, raw prompts, private source, session state, or large logs in
an envelope.

Validate an envelope and verify the pinned workflow material with:

```sh
node scripts/validate-task-envelope.mjs /path/to/task-envelope.json
node scripts/verify-workflow-lock.mjs
```

The local workflow resources are pinned in .codex/workflow-lock.json.

Both commands are read-only. A lock mismatch means the workflow material has
changed and its adoption must be reviewed before using it as delivery evidence.
