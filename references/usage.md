# Codex Sync usage guide

## Example three-device topology

| Device | Device ID | Local vault | Personal skill roots | Schedule |
| --- | --- | --- | --- | --- |
| Windows desktop | `win-main` | `D:\CodexSyncVault` | `~/.codex/skills` | every 5 minutes |
| Windows laptop | `win-travel` | `E:\CodexSyncVault` | `~/.codex/skills` | every 15 minutes |
| macOS | `mac-main` | `~/CodexSyncVault` | `~/.codex/skills`, `~/.hermes/skills` | LaunchAgent installed |

Different local paths are expected. In this example, all paths represent the same Syncthing folder ID, `codex-sync-vault`.

## Invocation

Use `$codex-sync` for native Codex skill invocation. `/codex-sync` is a conversational alias interpreted by the skill.

| Request | Result |
| --- | --- |
| `$codex-sync current` | Select the current Codex task, then synchronize it. |
| `$codex-sync` | Synchronize all selected tasks and configured skill roots now. |
| `$codex-sync status` | Show local configuration, selected tasks, sources, conflicts, and scheduler state. |
| `$codex-sync devices` | Show reports received from every bootstrapped device. |
| `$codex-sync skills` | Discover common personal skill roots and synchronize them. |
| `$codex-sync doctor` | Check Node, Codex storage, vault, SQLite index, Syncthing access, and forbidden files. |
| `$codex-sync audit <task>` | Check JSONL syntax, tool-call/output pairs, turn closure, and local index agreement. |
| `$codex-sync repair <task>` | Back up and repair interrupted tool events and stale older turns without inventing output. |
| `$codex-sync auto` | Install or refresh the local automatic task. |
| `$codex-sync project discover` | List Codex desktop projects and the local tasks grouped under each root. |
| `$codex-sync project current` | Register the current project and select every non-archived task under it. |
| `$codex-sync projects` | List project folder IDs and their real local paths. |

## Daily workflows

### Select a task once

From the task to preserve, invoke `$codex-sync current`. Selection propagates to the other devices. Only explicitly selected tasks are synchronized.

To select by title or ID from another task, run:

```text
node <skill-dir>/scripts/codexsync.mjs conversation select "<title-or-thread-id>"
node <skill-dir>/scripts/codexsync.mjs sync
```

If a title matches more than one task, use the full thread ID.

### Stop future synchronization

Run `conversation unselect <id-or-title>`, then `sync`. Existing vault data is retained; unselect is not deletion.

### Synchronize personal skills

Configured roots synchronize automatically. Add a nonstandard root once:

```text
node <skill-dir>/scripts/codexsync.mjs skills add --name <collection> --path "<skill-root>" --exclude .system
node <skill-dir>/scripts/codexsync.mjs sync
```

Use stable collection names across devices. Keep incompatible agent ecosystems in separate collections such as `codex` and `hermes`; central storage does not require installing every collection into every agent.

### Register a project

First inspect the roots and task grouping known to Codex:

```text
node <skill-dir>/scripts/codexsync.mjs project discover
```

Run this once on the originating device from the actual project root:

```text
$codex-sync project current
```

`project add` also selects every non-archived task whose `cwd` belongs to the project root. Run `sync` so the portable project catalog and those stable task histories reach the vault.

On another device, inspect and accept the advertised folder ID:

```text
node <skill-dir>/scripts/codexsync.mjs project catalogs
node <skill-dir>/scripts/codexsync.mjs project accept <folder-id> --path "<local-project-path>"
node <skill-dir>/scripts/codexsync.mjs sync
```

`project accept` preserves the source Syncthing folder ID, maps the source path to the target path for imported task metadata, and registers the local root in the Codex desktop Projects list. Do not independently create a second folder ID for the same project.

### Verify health

Run:

```text
$codex-sync doctor
$codex-sync status
$codex-sync devices
```

Healthy output has `ok: true`, no conversation or skill conflicts, `rolloutExists: true`, `indexedInStateDb: true`, and a device report for each expected device. Require the same current `protocolRevision` and `scriptSha256` across the fleet, plus `lastRunOk: true` after automatic scheduling is restored.

For an actively running task, `stable: false` is expected until its final answer. Require `semanticOk: true`, zero persistent dangling calls, and zero stale open turns. Codex Sync publishes only the independently stable prefix before the active turn; if no healthy prefix exists, it skips the task while continuing skills and projects.

## Interpreting sync results

- `conversationsPushed/Pulled`: complete selected-task snapshots published or imported in this run.
- `skillFilesPushed/Pulled`: changed files copied after three-way comparison.
- `conversationConflicts`: independently continued histories that require an explicit choice.
- `skillConflicts`: files changed differently on both sides; originals remain untouched.
- `projectSharesAdded`: configured projects newly shared with paired Syncthing devices.
- `warnings`: actionable conditions; do not ignore them during deployment.
- `conversationsSkipped`: active or semantically incomplete snapshots/heads that were deliberately quarantined.
- `conversationErrors`: per-task failures contained without stopping unrelated collections.

A new device commonly reports `conversationsPushed: 0` and `conversationsPulled: 1` on its first sync. That is normal: it had nothing local to publish. Its next manual or scheduled sync publishes its own device head.

## Manual CLI locations

- Windows: `%USERPROFILE%\.codex\skills\codex-sync\scripts\codexsync.mjs`
- macOS: `~/.codex/skills/codex-sync/scripts/codexsync.mjs`
- Local configuration: `~/.codex-sync/config.json`
- Local three-way state and recovery copies: `~/.codex-sync/state` and `~/.codex-sync/conflicts`

Always pass `--config <path>` for alternate profiles. Never copy `~/.codex-sync/config.json` between devices because device IDs and local paths must remain unique.

## Data boundary

Codex Sync includes selected conversation JSONL, portable thread metadata, user-defined skill files, selections, and device reports. It excludes authentication, Codex configuration, full SQLite/WAL databases, logs, caches, generated attachments, system skills, and plugin caches.

Conversation messages that reference local attachments or project files still synchronize as text, but the referenced files do not. Register the containing project separately or transfer those files through an approved storage path.

## Maintenance and repair

Before a repair or fleet upgrade:

```text
node <skill-dir>/scripts/codexsync.mjs maintenance on --reason "repair"
node <skill-dir>/scripts/codexsync.mjs conversation audit <id>
node <skill-dir>/scripts/codexsync.mjs conversation repair <id> --title "<known title>"
```

Disable each device scheduler and pause the Syncthing folder separately; old clients do not understand the maintenance marker. After validation, publish the updated skill with one controlled `sync --force`, remove maintenance with `maintenance off`, resume the transport, and reinstall/re-enable schedulers.

## Git helper crash note

Folder-transport deployments do not invoke `git-remote-https.exe` during routine Codex Sync runs. A `git-remote-https.exe` application error therefore comes from another Git operation or a damaged/misconfigured Git installation, not from conversation or skill reconciliation. Keep folder transport active while repairing Git. Follow the Git helper crash runbook in [deployment.md](deployment.md).
