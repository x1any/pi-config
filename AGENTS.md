# AGENTS.md

Guidelines for AI agents working in this repository.

- Keep changes small, focused, and consistent with existing style.
- This is a personal Pi config package:
  - `extensions/` contains Pi extensions.
  - `skills/` contains agent skills; each skill should include a `SKILL.md`.
- Avoid hard-coded local absolute paths; prefer relative paths or clear placeholders.
- Do not add dependencies or large refactors unless explicitly needed.
- Keep documentation concise and update `README.md` when user-facing behavior changes.
- Before finishing, check `git diff` and `git status`.
