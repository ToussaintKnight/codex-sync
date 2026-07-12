# Security and privacy

**English** | [简体中文](SECURITY.zh-CN.md)

## Reporting a vulnerability

Use GitHub's private security-advisory flow for vulnerabilities or suspected data exposure. Do not open a public issue containing conversation text, local paths, device identifiers, credentials, or vault contents.

Include the affected Sync2 version, platform, reproduction steps using synthetic data, and the expected security boundary. Remove secrets before attaching logs.

Before every push or release, run `npm run privacy:scan`. If a credential has already reached Git history or a remote, revoke or rotate it; deleting it in a later commit is not sufficient.

## Data model

Sync2 is a local-first synchronization tool. It reads selected Codex rollout files and user-configured skill roots, then writes sanitized protocol state into a user-controlled vault.

The vault may contain plaintext conversation bodies and source code. Sync2 does not encrypt the vault. Use encrypted disks, trusted Syncthing peers, or a private Git repository with appropriate access controls.

Sync2 must not copy:

- Codex authentication or API credentials;
- complete Codex databases or WAL files;
- local configuration containing installation identity;
- logs, caches, models, attachments, or plugin/system skill caches;
- private keys, environment files, or unrelated project directories.

## Operational safety

- Back up rollout and index state before repair.
- Disable old schedulers before reconnecting devices during a protocol migration.
- Use maintenance mode for repair and fleet upgrades.
- Never force-reset or force-push a Git vault.
- Treat unexpected `.sync-conflict-*` files as a transport incident.
- Review `device report` output before sharing it outside a trusted vault because it can contain local paths.

## Supported versions

Security fixes are applied to the latest version on the default branch. Older snapshots should be upgraded before troubleshooting.
