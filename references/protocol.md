# Sync2 protocol and edge cases

## Contents

1. Local and shared state
2. Conversation reconciliation
3. Selection events
4. Skill reconciliation
5. Device reports and cold start
6. Syncthing project folders
7. Git transport
8. Scheduler and locking
9. Security and portability boundaries
10. Conflict recovery

## 1. Local and shared state

```text
vault/
  .sync2/
    vault.json
    maintenance.json
    selections/<device>.json
    device-reports/<device>.json
  conversations/<thread-id>/
    metadata.json
    metadata/<device>.json
    canonical.jsonl
    heads/<device>.jsonl
    archived-heads/...
    conflict.json
  skills/<collection>/...
  conflicts/skills/<collection>/...
```

Local-only state lives under `~/.sync2`:

- `config.json`: device ID, local vault path, Codex home, sources, projects, and schedule settings;
- `state/`: last synchronized skill hashes for three-way comparison;
- `conflicts/conversations/`: local history backups created during explicit resolution;
- scheduler specification and local operation lock.

Never synchronize local config or base state between devices. They contain device-specific paths and identity.

## 2. Conversation reconciliation

Treat Codex rollout JSONL as append-only. Read only complete JSON records; discard an incomplete final line from a live writer snapshot.

Before publishing, validate both syntax and event semantics. Pair every `custom_tool_call`/`function_call` with its output and close every older turn with `task_complete` or `turn_aborted`. Treat calls belonging to the latest open turn as transient. Never publish that active turn; if the prefix before its `task_started` event is independently stable, publish that completed prefix as a checkpoint. This prevents long-running Goals from starving sync when a new turn starts immediately after each completion.

Each device publishes its stable local snapshot to `heads/<device>.jsonl`. Reconciliation compares raw bytes:

- when every shorter head is a byte prefix of the longest, promote the longest to `canonical.jsonl`;
- when any pair diverges, retain the existing canonical, preserve all heads, and write `conflict.json`;
- never interleave turns or invent a merged event order.

Ignore semantically incomplete heads and canonical files. Continue skill and project synchronization instead of failing the entire run. Once a valid longer head arrives, it can replace an invalid old canonical without treating the invalid copies as merge candidates.

Import only a semantically complete canonical into the platform-appropriate `~/.codex/sessions/YYYY/MM/DD` path. Update that thread in `state_5.sqlite`, `session_index.jsonl`, and an existing local desktop catalog row. Do not copy database files between devices.

Keep `metadata.json` portable and stable. Store mutable device rows and local paths under `metadata/<device>.json` so Syncthing never has several writers for one metadata file.

The imported `cwd` can reference a path that does not exist on the destination. The task remains readable, but project operations require an equivalent local checkout or an explicit path mapping in local config.

## 3. Selection events

Store per-device selection events in `.sync2/selections`. Merge by `updatedAt`, with device ID as a deterministic tie-breaker. Therefore:

- keep device clocks synchronized;
- use a unique device ID per installation;
- treat unselect as stopping future synchronization, not deleting exported content;
- reissue select/unselect after correcting a clock skew.

## 4. Skill reconciliation

Compare local hash, vault hash, and the last successful local base hash for each relative file:

- equal local and vault -> record the common base;
- one side equals base -> copy the changed side;
- one side is absent -> restore/copy the existing side because deletion is non-propagating;
- both sides changed differently -> preserve originals and write conflict copies.

Skip symlinks because targets and permissions are not portable. Exclude `.system`, plugin caches, `.git`, `node_modules`, `__pycache__`, and generated Sync2 conflict copies.

Keep ecosystems in separate collections. `skills/hermes/foo` can be centrally stored without installing it into Codex on every device.

Case-only file or directory names are unsafe across Windows and default macOS filesystems. Normalize them before synchronization.

## 5. Device reports and cold start

`device report` publishes content-stable evidence about platform, Node version, protocol revision, Sync2 script SHA-256, vault, selected-task local/vault health, skill counts, scheduler state, and last-run result. `device list` reads all propagated reports. Do not declare a fleet upgraded until every expected device reports the same current protocol revision and script hash.

On a new device, the first sync usually performs this order:

1. publish the device's initially empty or local selection state;
2. merge remote selections;
3. find no local rollout to export;
4. reconcile and import canonical;
5. pull skill files.

Consequently, the first result can show `conversationsPushed: 0` and `conversationsPulled: 1`. A second sync publishes the newly imported local head. This is expected, not data loss.

A report proves the explicit bootstrap reached the reporting step. To prove automatic scheduling, verify the scheduler's last result and observe a later report or head timestamp.

## 6. Syncthing project folders

Conversation/skill vault synchronization works whenever an external tool keeps the vault directory synchronized; Sync2 does not require the Syncthing executable for this core path.

The executable is required for `project`, `syncthing add-device`, rescan, and automatic project sharing. Store its device-specific executable path only in local config.

Register each project as a sibling independent Syncthing folder pointing at its real path. Reject parent/child overlaps. Generate the folder ID once on the originating device; other devices accept the offered ID and choose local paths.

Transport-level `.sync-conflict-*` files indicate Syncthing observed concurrent changes outside a single reconciled view. Preserve them and resolve manually before resuming automatic sync.

## 7. Git transport

Before reconciliation, run `git pull --rebase --autostash` when an upstream exists. After reconciliation, stage only Sync2 vault paths, commit when changed, and push only with an upstream.

Stop on any Git error. Never reset, force-push, or auto-resolve a Git conflict. Do not expose conversation data through a public repository.

## 8. Scheduler and locking

Use Task Scheduler on Windows and a per-user LaunchAgent on macOS. Store the exact Node executable, skill script, and config path in the scheduler definition. Record every non-dry automatic result under local `~/.sync2/runs/<device>-last.json`.

Use a local operation lock to suppress overlapping runs on one device. The lock cannot serialize disconnected devices; protocol-level heads and three-way hashes provide cross-device safety.

Create `.sync2/maintenance.json` before repairs, protocol migrations, or fleet upgrades. New clients refuse normal writes while it exists; use `--force` only for the one controlled maintenance write. Older clients do not understand this marker, so disable their schedulers before reconnecting them.

Report local rollout health separately from vault health. During maintenance, show unsafe heads without failing the local repair gate. Outside maintenance, make `doctor` fail until the canonical and every device head are stable; this prevents a healthy Win A from masking stale corrupted heads elsewhere.

Reinstall the scheduler after Node moves, the skill path changes, the config path changes, or the interval changes. A mapped, removable, or network drive must be mounted in the scheduler's user context.

## 9. Security and portability boundaries

Include only selected rollout JSONL, portable thread metadata, user skill contents, selections, project registrations, and device reports.

Exclude:

- `auth.json`, API keys, installation IDs, and device credentials;
- `config.toml`, full SQLite/WAL databases, logs, caches, and models;
- attachments and generated images;
- system and plugin-managed skill caches;
- arbitrary project contents unless registered separately.

Conversation bodies and skill contents remain plaintext in the vault. Use trusted encrypted endpoints, an encrypted container, or a private Git repository.

## 10. Conflict recovery

### Conversation

1. Stop editing the task on every device.
2. Inspect `conflict.json` and hash every file in `heads/`.
3. Choose the one history that should continue.
4. On each affected device run:

```text
node <skill-dir>/scripts/sync2.mjs conversation resolve <thread-id> --from-device <chosen-device>
```

5. Sync again on each device and require `conflict.json` to disappear.

Resolution archives nonchosen vault heads and backs up a differing local history under `~/.sync2/conflicts/conversations` before replacement.

### Interrupted tool call or stale turn

1. Disable the scheduler and pause the transport folder.
2. Back up the rollout, state database, session index, desktop catalog database, and vault task directory.
3. Run `conversation audit <id>`.
4. Run `conversation repair <id> --title <known-title>`. The repair appends an explicit interrupted-output placeholder and aborts only stale older turns; it does not fabricate the original output or close the currently executing turn.
5. Require zero persistent dangling calls, zero stale open turns, and consistent titles across indexes.
6. Leave invalid old heads quarantined until a stable local final turn publishes a valid replacement canonical.

### Skill file

1. Stop automatic runs if edits are ongoing.
2. Compare the local original, vault original, and files under `vault/conflicts/skills`.
3. Write the intentionally chosen or manually merged content to both the configured local root and vault path.
4. Remove only obsolete conflict copies after backup.
5. Run sync twice and require zero new skill conflicts.

### Stale operation lock

Sync2 considers a local operation lock stale after its safety interval. Before removing a lock manually, confirm no scheduler or interactive Sync2 process is still running.
