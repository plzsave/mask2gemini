# Repository instructions

## Start here

- Before changing the project, read `SPEC.md`, `README.md`, and `CLAUDE.md`.
- Treat the confirmed decisions in `SPEC.md` as fixed requirements. Do not reopen or
  silently weaken them.
- Preserve the core constraints: deterministic masking without an LLM, recall-first
  behavior, mandatory human review, local-only processing, vanilla JavaScript, and no
  build step for the extension.

## Issue-driven workflow

- Bugs and feature changes must have a GitHub Issue before implementation begins.
- Use one Issue per independently actionable problem. Include the observed behavior,
  reproduction conditions, expected behavior, acceptance criteria, and required
  regression tests.
- Create the implementation branch from the current `main` after the Issue exists.
  Use `fix/issue-<number>-<slug>` for fixes and `feat/issue-<number>-<slug>` for features.
- Keep the change scoped to the Issue. Do not mix unrelated cleanup into the same PR.
- Open a PR that links the Issue with `Closes #<number>` and reports the verification
  commands and results. Do not push implementation commits directly to `main`.

## Implementation and verification

- Keep masking policy in the pure modules under `extension/` and add focused unit tests
  for every rule or state transition that changes.
- When changing masking behavior, run both:

  ```bash
  bun run test
  bun run test:e2e
  ```

- Run `node --check` on changed JavaScript files when the test command does not already
  exercise their syntax.
- The real `background.js` action-click/injection path is not covered by the current
  Playwright setup; changes there require an explicit manual check or a focused mocked
  integration test.
- Preserve user-owned and unrelated worktree changes.

## Review priorities

- Prioritize functional correctness, specification gaps, recovery from user mistakes,
  and regression coverage.
- Report security concerns when they can expose unmasked source data or break an explicit
  local-only/privacy guarantee. Avoid treating optional hardening as a release blocker.

## Release workflow

- Follow the release decision rules and mechanical release procedure in `CLAUDE.md`.
- Do not create a release merely because a PR was opened; evaluate release requirements
  after the change is merged to `main`.
