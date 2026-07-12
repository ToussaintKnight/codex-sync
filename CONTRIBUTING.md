# Contributing

**English** | [简体中文](CONTRIBUTING.zh-CN.md)

## Development setup

Install Node.js 22 or newer. The test suite has no third-party runtime dependencies.

```sh
npm run check
```

## Change workflow

1. Open an issue describing the user impact, reproduction, and safety boundary.
2. Create a focused branch from the default branch.
3. Add or update a deterministic test before changing synchronization behavior.
4. Run `npm run check` on the platforms affected by the change.
5. Open a pull request and complete the privacy checklist.

## Safety invariants

Changes must preserve these rules:

- never copy authentication or complete Codex databases;
- never publish an active or semantically incomplete turn;
- never silently merge divergent conversation histories;
- never silently overwrite simultaneous skill edits;
- never propagate deletion automatically;
- never force-reset or force-push Git transport;
- always keep repair operations recoverable from a local backup.

Use synthetic IDs, paths, conversations, and device names in tests and documentation. Do not contribute real vault data, local reports, IP addresses, usernames, or screenshots containing private task content.

The repository-native privacy gate rejects forbidden state files, credential shapes, private home paths, device IDs, and non-example email addresses. Treat a finding as a release blocker, not as a warning to ignore.

## Pull requests

Keep changes scoped and describe root cause, user impact, validation, and rollback. A maintainer may request cross-platform evidence for filesystem, scheduler, or SQLite changes.
