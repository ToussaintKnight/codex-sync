---
name: codex-sync
description: Run Codex Sync to safely synchronize selected local Codex conversations, user-defined skills, and explicitly selected project directories across Windows and macOS through Syncthing, a shared folder, cloud-drive folder, or private Git repository. Use when the user invokes $codex-sync or writes /codex-sync, starts a new project that should become its own Syncthing folder, asks to sync/export/import a current or named Codex task, wants personal Codex/Hermes/agent skills mirrored between devices, needs sync status or conflict recovery, or wants automatic scheduled synchronization.
---

# Codex Sync

Use `$codex-sync` to invoke the Codex Skill. The bundled shell CLI and Node entry point are named `codexsync` to avoid colliding with an operating-system `sync` command. Store local protocol state under `.codex-sync/`.

Use the bundled cross-platform Node script for all state changes. Keep credentials, `auth.json`, device IDs, SQLite databases, logs, caches, system skills, and plugin caches out of the vault.

## Command routing

Interpret `/codex-sync` as an alias for this skill. Prefer `$codex-sync` when explaining native Codex invocation because skills are natively invoked with `$`.

Run:

```text
node <skill-dir>/scripts/codexsync.mjs <command>
```

Map requests as follows:

- `/codex-sync setup <vault>` -> `init --vault <vault>`
- `/codex-sync current` -> `conversation select current`, then `sync`
- `/codex-sync <title-or-id>` -> `conversation select <title-or-id>`, then `sync`
- `/codex-sync` or `/codex-sync now` -> `sync`
- `/codex-sync status` -> `status`
- `/codex-sync skills` -> `skills discover`, show findings, then `sync`
- `/codex-sync auto` -> `daemon install`
- `/codex-sync doctor` -> `doctor`
- `/codex-sync audit <task>` -> `conversation audit <task>`
- `/codex-sync repair <task>` -> enable maintenance, back up, then `conversation repair <task>`
- `/codex-sync maintenance` -> `maintenance status`
- `/codex-sync move <vault>` -> `vault use --vault <vault> --transport <folder|git>`
- `/codex-sync project current` -> run `project add current` from the project root
- `/codex-sync project <path>` -> `project add <path>`
- `/codex-sync projects` -> `project list`
- `/codex-sync project discover` -> `project discover` to list Codex Projects and their local tasks
- `/codex-sync devices` -> `device list`

Always quote paths. Use `--config <path>` when operating a test or non-default profile.

## First-time setup

1. Run `doctor` and inspect the reported Codex home, Node version, SQLite support, and common skill roots.
2. Ask for a vault path only when one cannot be inferred. A vault is a directory already shared by Syncthing/Jianguoyun, or a checked-out private Git repository.
3. Run `init --vault <path> --transport folder` for Syncthing/cloud folders, or `init --vault <clone-path> --transport git [--repo <private-url>]` for Git.
4. Run `skills discover`. Register additional roots with `skills add --name <collection> --path <root>`.
5. Select conversations explicitly. Do not sync every conversation by default.
6. Run `sync`, review the summary, then optionally run `daemon install --minutes 5`.

Never initialize a public Git repository for conversation data. Explain that vault content is plaintext at rest unless the surrounding storage is encrypted.

## Project folders through Syncthing

Manage project folders through the background CLI/API; do not open the Syncthing UI unless the user explicitly asks for visible inspection.

1. Run `syncthing configure --syncthing-exe <path>` once when automatic detection fails.
2. Run `project discover` to show the project roots currently known to the Codex desktop app and the non-archived local tasks whose `cwd` belongs to each root.
3. From an originating project root, run `project add current`. The command creates one independent Syncthing folder entry pointing directly at that project and selects every non-archived Codex task under that root. It never copies the project into another Syncthing directory. Use `--no-tasks` only when project files should be shared without task history.
4. Share with all paired remote devices by default. Use `--share-with <device-name-or-id>` or `--share-with none` for a narrower set. Add repeated `--ignore <Syncthing-pattern>` arguments when generated caches or large local-only paths must stay out.
5. Reject parent/child overlap with an existing Syncthing folder. Keep each selected project and the Codex Sync conversation vault as sibling, independent folder entries.
6. Run `sync` on the source so `.codex-sync/project-catalogs/<device>.json` advertises the portable folder ID, source path, and selected tasks.
7. On a target device run `project catalogs`, then `project accept <folder-id> --path <local-path>`. This preserves the source folder ID, adds a source-to-local path map, and registers the local root in Codex via its supported `codex://new?path=...` deep link. Use `--no-register` only when UI registration is intentionally deferred. Do not independently generate a second folder ID.
8. Verify with `project status <folder-id>` and use `project rescan <folder-id>` only when the filesystem watcher has not noticed a change. If only task selection needs repair, run `project tasks <path>`; if only paths need repair, run `project map --from <source-path> --to <local-path>`.
9. Pair a new machine with `syncthing add-device --device-id <ID> --name <name>`. Projects registered with the default `sharePolicy=all` are shared to newly paired remote devices by the next scheduled `sync` run.
10. Use `device report` on a newly bootstrapped machine. Scheduled sync also publishes a content-stable device report so another device can verify local conversation indexes, project catalogs, skill counts, and daemon installation without copying terminal output.

## Safety behavior

- Treat conversation JSONL as append-only. Publish a per-device head and advance the canonical copy only when all heads have a prefix relationship.
- Require semantic and desktop-projection completeness in addition to valid JSON: every tool call needs a matching output, every older turn needs `task_complete` or `turn_aborted`, and repaired aborts need Codex-compatible completion fields.
- Never export the active turn or the tool call currently running Codex Sync. When possible, publish the semantically complete prefix before the active turn as a stable checkpoint; otherwise skip the task until a healthy checkpoint exists.
- Quarantine incomplete local snapshots, heads, and canonical files from import or promotion while continuing independent skill/project work.
- On divergent conversation history, preserve every head, emit a conflict, and do not invent a merged history.
- Use three-way hashes for skills. On simultaneous edits, preserve local and remote versions as conflict copies; never silently choose one.
- Do not propagate deletions automatically.
- Do not edit or sync live Codex SQLite/WAL files as files. Import only the selected thread row through SQLite and copy a complete-line JSONL snapshot.
- Default Codex skill discovery must exclude `.system`; never add plugin cache roots as personal skill collections.
- Stop if Git pull/rebase reports a conflict. Do not force-push or reset.
- Store portable core metadata once and device-specific metadata under `metadata/<device>.json`; never let several devices rewrite one mutable metadata record.
- Use `maintenance on` before repair or migration. Normal sync must stop while the marker exists unless a controlled run explicitly passes `--force`.
- Record the last automatic run result under local `~/.codex-sync/runs`; an installed scheduler is not evidence of success.

## Verification and recovery

Read [usage.md](references/usage.md) for daily commands and output interpretation. For first-machine, new-machine, reinstall, or path-change deployment, follow [deployment.md](references/deployment.md). For edge cases, conflict semantics, and storage boundaries, consult [protocol.md](references/protocol.md).

After setup or material changes, run `conversation audit <task>`, `doctor`, `sync --dry-run`, `sync`, `device report`, and `status`. A healthy active task may report one open latest turn and active calls; it must report zero persistent dangling calls, zero stale open turns, and zero projection-unsafe abort events. Outside maintenance, `doctor` must also require a stable canonical and stable head from every device.

If an imported task does not appear immediately in the Codex sidebar, verify its JSONL and `state_5.sqlite` row with `doctor`, then restart Codex once. Do not copy the source device's whole database.
