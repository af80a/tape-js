# Simplification Playbook

Use this reference when the refactor spans multiple files, tests are thin, or package boundaries may change.

## Scope Selection

- Stay at function scope for conditionals, naming, duplication, and local data flow.
- Move to module scope for ownership problems, circular imports, or helper sprawl.
- Move to package scope for dependency cycles, leaky public APIs, or concepts split across artificial boundaries.

## Characterization Checklist

- Identify every observable contract before editing: exports, side effects, errors, timing, ordering, wire formats, and persisted shapes.
- Freeze current behavior with the narrowest tests that cover those contracts.
- Separate required compatibility from accidental historical structure.

## Safe Simplification Patterns

- Inline pass-through helpers that only rename or forward arguments.
- Collapse re-export mazes into direct imports when ownership is already clear.
- Replace configuration-heavy abstractions with explicit branching when the supported cases are few and stable.
- Co-locate types and logic when splitting them forces readers to reconstruct one concept from many files.
- Split pure computation from effectful adapters before reorganizing larger boundaries.

## Risk Signals

- Initialization order changes.
- Async scheduling or event timing changes.
- Numeric or DSP behavior changes hidden behind a refactor.
- Shared utilities with many callers and weak tests.
- Public APIs that are indirectly depended on through re-exports.

## Package-Level Refactors

- Map dependency direction before moving files.
- Remove cycles instead of relocating them.
- Shrink public surface area before introducing new package boundaries.
- Migrate in stages when consumers cannot move atomically.
- Leave a clear seam between domain logic and integration code.

## Stop Conditions

- Stop when the next change would alter product behavior instead of structure.
- Stop when test coverage cannot prove the refactor safe and no reliable characterization strategy exists.
- Stop when a new abstraction is being added mainly to justify the refactor itself.
