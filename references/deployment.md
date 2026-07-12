# Sync2 deployment and cold-start guide

## Contents

1. Deployment invariants
2. Cold-start matrix
3. First device and empty vault
4. New Windows device
5. New macOS device
6. Existing or stale local configuration
7. Git transport
8. Automatic scheduling
9. Cross-device acceptance test
10. Edge-case runbook
11. Interrupted-rollout fleet recovery
12. Recovery and removal

## 1. Deployment invariants

Meet these conditions before bootstrap:

- Install Node.js 22 or newer and make `node` available in the interactive shell.
- Launch Codex at least once when possible so `~/.codex` and `state_5.sqlite` exist. Sync2 can still copy a session without the database, but Codex may need one restart to backfill its sidebar index.
- Create or accept one shared vault folder. Different local paths are normal; the Syncthing folder ID must be the same.
- Wait until the vault reports fully synchronized before running a new-device bootstrap. The file `skills/codex/sync2/SKILL.md` must exist locally.
- Give every machine a unique stable device name such as `win-a`, `win-b`, or `macos`.
- Keep system clocks synchronized because selection events use last-writer-wins timestamps.
- Use a private Git repository or trusted encrypted storage. Vault content is plaintext at rest.
- Keep the vault mounted and writable whenever an automatic task runs.

Never copy another machine's `~/.sync2/config.json`, Codex SQLite files, `auth.json`, or whole `~/.codex` directory.

## 2. Cold-start matrix

| Starting condition | Correct entry point | Expected first result |
| --- | --- | --- |
| Empty vault, first device | Install the skill locally, then run `init` | Personal skills push into the new vault; no tasks move until selected. |
| Populated vault, completely new device | Run the vault bootstrap script | Skill installs locally, config initializes, selected tasks and skills pull, scheduler optionally installs. |
| Populated vault, Codex never launched | Prefer launching Codex once, then bootstrap | Session files import; if no state DB existed, restart Codex once for indexing. |
| Existing Sync2 config with a wrong or old vault path | Run the current bootstrap or `vault use` | Config changes to the supplied local path without copying another device's config. |
| Reinstalled OS with an existing synchronized vault | Treat as a new device; choose a new unique device ID | Vault content pulls; old device report remains historical until manually retired. |
| Vault path is offline, unmapped, or partially synchronized | Stop and restore/mount/synchronize it first | Do not initialize against an empty placeholder directory. |
| Existing local skills differ from the vault | Back up if desired, then bootstrap | Three-way state is new; differing same-path files are preserved as conflicts, not overwritten. |
| Private Git transport | Clone or let `init --repo` clone first | Pull/rebase precedes every reconciliation; commits push only with an upstream. |

## 3. First device and empty vault

Install `sync2` into the first device's Codex skill root, then run:

```text
node <skill-dir>/scripts/sync2.mjs init --vault "<local-shared-path>" --transport folder --device <unique-id>
node <skill-dir>/scripts/sync2.mjs skills discover
node <skill-dir>/scripts/sync2.mjs sync --dry-run
node <skill-dir>/scripts/sync2.mjs sync
node <skill-dir>/scripts/sync2.mjs daemon install --minutes 5
node <skill-dir>/scripts/sync2.mjs device report
node <skill-dir>/scripts/sync2.mjs doctor
```

Select a harmless task with `$sync2 current`, run another sync, and confirm that `vault/conversations/<thread-id>/canonical.jsonl` exists.

For Syncthing, register the vault once as an independent folder and share that same folder ID with every target device. Do not nest separately registered projects inside the vault.

## 4. New Windows device

### Preconditions

Confirm all of the following:

```powershell
node --version
Test-Path "<vault>\skills\codex\sync2\SKILL.md"
Test-Path "<vault>\skills\codex\sync2\scripts\bootstrap-sync2.ps1"
```

Require Node 22+ and two `True` results. If the path is uncertain, search the actual Syncthing folder root rather than guessing:

```powershell
Get-ChildItem -LiteralPath "<search-root>" `
  -Filter "bootstrap-sync2.ps1" `
  -File -Recurse -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty FullName
```

### Bootstrap

```powershell
$vault = "<actual-local-vault-path>"
$bootstrap = Join-Path $vault "skills\codex\sync2\scripts\bootstrap-sync2.ps1"

powershell -ExecutionPolicy Bypass -File $bootstrap `
  -Vault $vault `
  -Device "<unique-device-id>" `
  -InstallDaemon `
  -Minutes 15
```

The script installs the skill, initializes a missing config or safely points an existing config at the supplied vault, synchronizes, installs Task Scheduler, publishes a device report, and runs doctor.

For example:

```powershell
$vault = "D:\Sync2Vault"
```

Use the exact local path shown by Syncthing on that device; local drive letters may differ.

### Windows post-check

```powershell
Test-Path "$HOME\.sync2\config.json"
schtasks.exe /Query /TN "Sync2-AutoSync" /FO LIST /V
node --no-warnings "$HOME\.codex\skills\sync2\scripts\sync2.mjs" status --json
node --no-warnings "$HOME\.codex\skills\sync2\scripts\sync2.mjs" doctor --json
```

If Task Scheduler cannot see a mapped or removable drive, use a stable local Syncthing path or ensure the drive mounts before login. Reinstall the daemon after changing the Node executable location.

## 5. New macOS device

### Preconditions

```sh
node --version
test -f "<vault>/skills/codex/sync2/SKILL.md"
test -f "<vault>/skills/codex/sync2/scripts/bootstrap-sync2.sh"
```

### Bootstrap

```sh
sh "<vault>/skills/codex/sync2/scripts/bootstrap-sync2.sh" \
  "<vault>" macos folder --daemon
```

The bootstrap now handles both a missing config and an existing config whose vault path changed.

Register Hermes after the first bootstrap when that root exists:

```sh
node --no-warnings "$HOME/.codex/skills/sync2/scripts/sync2.mjs" \
  skills add --name hermes --path "$HOME/.hermes/skills"
node --no-warnings "$HOME/.codex/skills/sync2/scripts/sync2.mjs" sync
node --no-warnings "$HOME/.codex/skills/sync2/scripts/sync2.mjs" device report
```

Verify the LaunchAgent:

```sh
launchctl print "gui/$(id -u)/com.openai.sync2"
node --no-warnings "$HOME/.codex/skills/sync2/scripts/sync2.mjs" doctor --json
```

If the vault is on an external volume, keep the volume mounted before the LaunchAgent runs. macOS privacy controls may require granting the shell or Node access to protected folders.

## 6. Existing or stale local configuration

Inspect the local config rather than deleting it:

```text
node <skill-dir>/scripts/sync2.mjs status --json
```

Change only the local vault path:

```text
node <skill-dir>/scripts/sync2.mjs vault use --vault "<correct-local-path>" --transport folder
```

The automatic task reads the same config path and follows the new vault. Do not use `init --force` as routine recovery; it can replace selections, sources, device identity, and project registrations.

When the old and new vault directories are not the same synchronized dataset, move or synchronize the vault content first. `vault use` changes configuration; it is not a general directory migration utility.

## 7. Git transport

Use only a private repository:

```text
node <skill-dir>/scripts/sync2.mjs init \
  --vault "<clone-path>" \
  --transport git \
  --repo "<private-repository-url>" \
  --device <unique-id>
```

Configure Git user identity and an upstream before expecting automatic pushes. Sync2 stops on pull/rebase, commit, or push failures and never force-pushes or resets.

Do not combine a Git working tree and another bidirectional file synchronizer on the same vault unless the operational conflicts are understood.

### Windows `git-remote-https.exe` application error

Do not call `git-remote-https.exe` directly. It is an internal helper launched by `git` for HTTPS remotes.

First confirm that Sync2 does not need Git:

```powershell
Get-Content -Raw "$HOME\.sync2\config.json" | ConvertFrom-Json |
  Select-Object deviceId, transport, vault
```

When `transport` is `folder`, leave it unchanged. Stop the crashed helper and identify the active Git installation:

```powershell
Get-Process git,git-remote-https -ErrorAction SilentlyContinue |
  Stop-Process -Force
Get-Command git -All | Select-Object Source, Version
git --version
git --exec-path
```

Back up user Git configuration before repair:

```powershell
if (Test-Path "$HOME\.gitconfig") {
  Copy-Item "$HOME\.gitconfig" "$HOME\.gitconfig.sync2-backup-$(Get-Date -Format yyyyMMddHHmmss)"
}
```

Repair Git for Windows in place from the official winget package, then open a new PowerShell window:

```powershell
winget source update
winget install --id Git.Git --exact --source winget --force `
  --accept-package-agreements --accept-source-agreements
```

The bundled equivalent performs diagnosis, backup, repair, and the isolated test in one explicit command:

```powershell
powershell -ExecutionPolicy Bypass -File `
  "<vault>\skills\codex\sync2\scripts\repair-git-https.ps1" `
  -Repair -TestHttps
```

Close Codex, GitHub Desktop, VS Code, and other active Git operations before running it from standalone PowerShell. Codex continuously launches short Git status processes while open, which can make the Git for Windows installer abort. The script detects respawned Git processes and stops with an explanation instead of leaving a partial repair. It does not change persistent proxy or SSL settings.

Run an isolated HTTPS test that bypasses user proxy settings and uses Windows certificate handling:

```powershell
git -c http.proxy= -c http.sslBackend=schannel `
  ls-remote https://github.com/git/git.git HEAD
```

Expected output is one commit hash followed by `HEAD`. If this succeeds but normal Git still crashes, inspect configuration sources and test the configured local proxy before changing them:

```powershell
git config --show-origin --get-regexp '^(http\.|credential\.|core\.askpass)'
Test-NetConnection 127.0.0.1 -Port 7890
```

Do not blindly delete proxy settings when a local proxy is intentional. If the isolated test still crashes after reinstall, restart Windows to release old DLLs, repeat the test, and collect the Application Error event:

```powershell
Get-WinEvent -FilterHashtable @{
  LogName='Application'
  StartTime=(Get-Date).AddHours(-2)
  Level=2
} | Where-Object Message -Match 'git-remote-https|libcurl|msys-2.0' |
  Select-Object -First 5 TimeCreated, Id, ProviderName, Message |
  Format-List
```

Keep Sync2 on folder transport regardless; Git repair is required only for other Git workflows or a future deliberate Git transport migration.

## 8. Automatic scheduling

Install or refresh after changing Node, the skill location, the config location, or the desired interval:

```text
node <skill-dir>/scripts/sync2.mjs daemon install --minutes <N>
node <skill-dir>/scripts/sync2.mjs daemon status
```

Windows uses Task Scheduler with an interactive user token. macOS uses `~/Library/LaunchAgents/com.openai.sync2.plist`. Multiple overlapping runs are suppressed by a local operation lock.

An installed scheduler is not proof of a successful run. Check `status.lastRun.ok`, the OS scheduler result, and a later propagated device report. A nonzero OS result with a missing/failed local run record is unhealthy.

## 9. Cross-device acceptance test

Complete every item:

1. Run `doctor` on every device and require `ok: true` for core vault health.
2. Run `device report` on every device, then `device list` elsewhere; require all expected IDs, the same current protocol revision, the same Sync2 script SHA-256, and a successful last-run record.
3. Select one harmless task on device A and sync after its final answer. On device B, require `rolloutExists: true`, `indexedInStateDb: true`, and `semanticOk: true`.
4. Compare SHA-256 hashes of every device head and `canonical.jsonl`; require equality before concurrent continuation tests.
5. Continue the task on one device only, sync twice across the fleet, and verify the appended record arrives.
6. Confirm every configured skill collection and expected file count in `vault/skills`.
7. Create a test skill, synchronize it, and compare bytes on another configured root.
8. Test simultaneous skill edits offline; require conflict copies and no silent overwrite.
9. Test an intentionally divergent conversation offline only with disposable data; require `conflict.json` and preserved heads.
10. Run `sync --dry-run`; require zero unexplained warnings or conflicts.
11. Inspect the vault for `auth.json`, `config.toml`, `*.sqlite*`, logs, caches, and `.system`; require none.
12. Trigger or wait for each scheduler and confirm a fresh device report propagates.

## 10. Edge-case runbook

| Symptom | Cause | Action |
| --- | --- | --- |
| Bootstrap file is missing | Wrong local vault path or incomplete Syncthing download | Read Syncthing's actual Folder Path, wait for 100%, then search for the script. |
| Config is missing | Normal cold start | Run the bootstrap; do not copy another device's config. |
| Config points at an old path | Drive letter or mount point changed | Rerun the current bootstrap or use `vault use`. |
| `Syncthing executable was not found` but doctor is otherwise OK | The vault is already managed externally, but Sync2 cannot call Syncthing CLI | Core conversation/skill sync still works. Configure the executable only for project/device automation. |
| First sync pulls but does not push a conversation | New device had no local rollout at export time | Run sync again or wait for the scheduler; the second run publishes its head. |
| Task is on disk but absent from sidebar | Codex was open during import, state DB was absent, or UI has not refreshed | Run doctor, verify `indexedInStateDb`, then restart Codex once. |
| Scheduler is installed but updates stop | Node moved, vault was unmounted, user was logged out, or task last result is nonzero | Restore prerequisites and rerun `daemon install`. |
| Conversation conflict appears | Two devices continued the same task from the same base while disconnected | Stop editing, inspect every head, then resolve explicitly from one device. |
| Task reopens with missing progress or stays `inProgress` | A tool call lost its output event, an older turn lacks a close marker, or only commentary was persisted before interruption | Enter maintenance, back up, run `conversation audit`, then `conversation repair`; require zero persistent dangling calls and stale open turns. |
| `Path escapes root` contains `\\?\C:\...` | Windows returned an extended-length path | Upgrade Sync2 to protocol revision 2; do not rewrite the whole Codex home or database. |
| Sync reports an active task as skipped | Its current turn has not emitted a final answer and the prefix before it is not independently healthy | This is expected protection. Repair any older semantic gap or let the turn finish; healthy long-running Goals publish completed-prefix checkpoints. |
| Metadata `.sync-conflict-*` files appear repeatedly | Multiple devices are rewriting legacy shared `metadata.json` | Upgrade all clients; keep stable core metadata and write device rows under `metadata/<device>.json`, then archive old conflicts after backup. |
| Skill conflict appears | Both sides changed the same relative file | Compare local, vault, and conflict copies; choose intentionally and sync again. |
| Files deleted locally reappear | Deletion propagation is intentionally disabled | Remove unwanted data deliberately from both sides after backup; do not expect Sync2 to propagate deletion. |
| Attachments or project files are missing | Sync2 does not copy Codex attachments or arbitrary project content | Register the project separately or transfer the files through approved storage. |
| Same skill name differs only by case | Windows and default macOS filesystems are case-insensitive | Rename collections/files to unique case-insensitive names before sync. |
| Selection unexpectedly flips | Device clocks differ or a later unselect/select event won | Synchronize clocks and issue the desired selection again. |
| Git sync stops | Pull/rebase/push failure or missing upstream | Resolve Git normally; never force-reset the vault. |
| `git-remote-https.exe` references null memory | Damaged/mixed Git DLLs, injected security software, or HTTPS/proxy configuration | Keep Sync2 on folder transport, repair Git for Windows in place, then run the isolated `schannel`/no-proxy test above. |
| Syncthing creates `.sync-conflict-*` files | Transport-level concurrent edits bypassed Sync2's serialized view | Stop automatic sync, preserve both copies, reconcile manually, then resume. |
| Project registration is rejected | It overlaps a parent or child Syncthing folder | Use sibling independent folder roots; do not nest registrations. |

## 11. Interrupted-rollout fleet recovery

Use this order when other machines are asleep or powered off:

1. On the active machine, disable/stop the scheduler, pause the Syncthing vault folder, and enable `maintenance on`.
2. Back up the local rollout, `state_5.sqlite` through SQLite backup, `session_index.jsonl`, the desktop catalog database, local config, scheduler spec, skill, and vault task directory.
3. Upgrade Sync2 and pass its full tests. Run `conversation repair <id> --title <known-title>` and require `semanticOk: true`, zero persistent dangling calls, zero stale open turns, and consistent indexes.
4. Run `sync --dry-run`. Active local history and invalid old heads must be skipped, not imported. Use one controlled `sync --force` only to publish the upgraded skill/device report while maintenance is active.
5. Let the active Codex turn finish. The next healthy run publishes the stable full head and replaces the quarantined canonical.
6. Before reconnecting an old device, disable its Sync2 scheduler. Prefer booting Win B offline long enough to disable Task Scheduler; on macOS unload the LaunchAgent or pause its Syncthing folder before allowing exchange.
7. Resume transport, wait for the upgraded skill to arrive, run `conversation audit`, then reinstall the daemon from the upgraded skill. Do not continue the selected task until its local canonical is semantically healthy.
8. After all devices report the new protocol and healthy history, remove maintenance, resume all vault folders, enable schedulers, and complete the acceptance test.

Older clients do not understand the maintenance marker. Invalid old heads are retained but ignored; upgraded clients replace them after importing a stable canonical.

## 12. Recovery and removal

Before recovery, preserve the vault, `~/.sync2`, and any reported conflict copies.

Remove only automatic scheduling:

```text
node <skill-dir>/scripts/sync2.mjs daemon uninstall
```

Unregister a project without deleting local files:

```text
node <skill-dir>/scripts/sync2.mjs project remove <folder-id-or-path>
```

Unselect a task without deleting historical vault data:

```text
node <skill-dir>/scripts/sync2.mjs conversation unselect <id-or-title>
node <skill-dir>/scripts/sync2.mjs sync
```

Keep exported data until every device is healthy and a backup exists. Sync2 intentionally avoids destructive cleanup.
