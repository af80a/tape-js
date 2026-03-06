---
name: simplify-code-safely
description: Simplify existing code while preserving observable behavior. Use when Codex needs to reduce complexity, remove indirection, collapse file structure, reorganize modules, merge or split responsibilities, or redesign a package without introducing regressions. Trigger on requests to refactor, clean up, de-duplicate, flatten architecture, reduce abstraction, or make a codebase easier to understand while keeping APIs, tests, and runtime behavior stable.
---

# Simplify Code Safely

Simplify the smallest surface that yields a durable improvement. Preserve observable behavior unless the user explicitly asks for a functional change.

Read `references/simplification-playbook.md` when the refactor crosses file boundaries, changes public APIs, or considers package-level reorganization.

## Workflow

### 1. Lock down behavior

- Read the current implementation and the closest tests before editing.
- List the invariants that must survive: inputs and outputs, exported types, side effects, error semantics, ordering, async behavior, data formats, and contract-level performance constraints.
- Add narrow characterization tests first when behavior is implicit or under-tested.

### 2. Choose the smallest useful scope

- Refactor at function scope when the problem is local branching, naming, or duplication.
- Refactor at file or module scope when the problem is ownership, indirection, or split responsibilities.
- Refactor at package scope only when dependency direction, API surface, or concept boundaries are the real source of complexity.
- Prefer multiple safe passes over a single architectural rewrite.

### 3. Remove accidental complexity

- Delete dead code, obsolete flags, unused types, and one-off abstractions.
- Inline wrappers that do not earn their existence.
- Replace generic machinery with direct code when call sites are few and stable.
- Merge files or modules when they change together and the split only adds coordination cost.
- Split files or modules when unrelated responsibilities or change rates are entangled.
- Move effectful logic to edges and keep core transformations easy to test.
- Rename based on responsibility, not implementation detail.

### 4. Avoid unsafe changes

- Do not mix simplification with feature work unless the user explicitly asks for both.
- Do not silently change public APIs, serialization formats, timing, concurrency, or numeric behavior.
- Do not preserve an abstraction just because it is old; preserve it only if it protects a real boundary.
- Stop and call out the tradeoff when a simplification would reduce flexibility the codebase still needs.

### 5. Verify

- Run the smallest relevant tests first, then broader tests for shared code.
- Add or update tests only where they prove unchanged behavior or document an intentional boundary change.
- If full verification is impossible, state exactly what remained unverified and why.

### 6. Report

- Explain what complexity was removed.
- Explain why the new shape is easier to maintain.
- Cite the evidence that behavior stayed stable.

## Decision Rules

- Prefer deletion over relocation, relocation over abstraction, and abstraction over framework-level redesign.
- Prefer explicit data flow over cross-module indirection.
- Prefer stable seams around IO, persistence, UI boundaries, and package or public exports.
- Prefer package reorganization only after proving the problem cannot be solved inside current boundaries.

## Expected Outputs

- Smaller conceptual surface area.
- Fewer moving parts per feature.
- Clearer ownership for each file, module, or package.
- Test evidence or explicit risk notes.
