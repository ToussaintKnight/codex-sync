# Codex Sync2

Sync selected local Codex conversations and personal skills across Windows and macOS without copying credentials, entire databases, or unfinished conversation turns.

Sync2 is for people who use Codex on more than one computer and want a controlled, inspectable alternative to copying the whole `~/.codex` directory.

```text
Codex device A ─┐
                ├─ trusted private vault ─ stable conversation snapshots
Codex device B ─┤                         └ user-defined skills
Codex device C ─┘
```

> Privacy first: the vault contains plaintext conversation text and skill source. Use trusted encrypted storage or a private Git repository. Sync2 deliberately excludes authentication, full databases, logs, caches, attachments, and system/plugin skills.

## What it does

- Synchronizes only explicitly selected Codex tasks.
- Publishes only complete JSONL records and stable, closed turns.
- Keeps independent device heads and promotes a canonical history only when heads have a byte-prefix relationship.
- Quarantines incomplete or divergent history instead of inventing a merge.
- Synchronizes user skill collections with three-way hashes and preserved conflict copies.
- Supports Syncthing/shared-folder and private-Git transports.
- Updates Codex's local thread indexes without copying another device's SQLite database.
- Provides maintenance mode, recovery backups, health reports, and schedulers for Windows and macOS.

## Requirements

- Node.js 22 or newer
- Codex initialized at least once on each device
- A trusted shared folder, or a checked-out **private** Git repository
- Syncthing only when using project-folder automation or Syncthing transport

## Quick start

Install the repository as a Codex skill:

```sh
git clone <private-repository-url> codex-sync2
mkdir -p "$HOME/.codex/skills/sync2"
cp -R codex-sync2/. "$HOME/.codex/skills/sync2/"
```

Initialize one device against an existing trusted vault:

```sh
node "$HOME/.codex/skills/sync2/scripts/sync2.mjs" init \
  --vault "$HOME/Sync2Vault" \
  --transport folder \
  --device mac-main
```

In a Codex task, invoke:

```text
$sync2 current
```

Only selected tasks are exported. Run `$sync2 doctor` before enabling automatic scheduling.

Windows and macOS bootstrap commands are documented in [references/deployment.md](references/deployment.md).

## Safety model

Sync2 treats rollout JSONL as append-only. A snapshot is publishable only when:

1. every line is valid JSON;
2. every tool/function call has a matching output;
3. every older turn is completed or natively interrupted;
4. the active turn is excluded;
5. the result is a byte-prefix-compatible device head.

If any rule fails, Sync2 preserves the data and reports the problem. It does not silently choose, truncate, or fabricate history.

See [references/protocol.md](references/protocol.md) for reconciliation and recovery details.

## Verification

Run the deterministic end-to-end suite:

```sh
npm test
```

The suite covers folder and Git transports, conversation import, interrupted-event repair, stable active checkpoints, conflict preservation, maintenance mode, Windows extended paths, desktop catalog updates, device reports, and skill reconciliation.

CI runs the suite on Windows, macOS, and Linux with Node.js 22.

## Data boundaries

Included:

- explicitly selected rollout JSONL;
- portable task metadata;
- user-defined skill files;
- device selection events and health reports.

Excluded:

- `auth.json`, tokens, API keys, installation/device credentials;
- `config.toml`, complete SQLite/WAL databases, logs, caches, and models;
- attachments and generated images;
- system and plugin-managed skill caches;
- arbitrary project content unless registered separately.

## Limitations

- Conversation attachments are not copied.
- Continuing the same task independently on disconnected devices creates an explicit conflict that requires a human choice.
- Vault contents are not encrypted by Sync2 itself.
- Older Sync2 clients do not understand maintenance mode; disable their schedulers before a fleet upgrade.
- Codex storage formats may evolve, so run `doctor` and the test suite after Codex upgrades.

## Documentation

- [Usage guide](references/usage.md)
- [Deployment and cold start](references/deployment.md)
- [Protocol and recovery](references/protocol.md)
- [Demonstration](docs/demo.md)
- [Roadmap](docs/roadmap.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

## License

MIT. See [LICENSE](LICENSE).
