# Changelog

All notable changes are documented here.

## Unreleased

- Detect and quarantine abort events that are semantically closed but incompatible with Codex desktop projection.
- Repair interrupted turns with Codex-native completion metadata while preserving an explicit non-fabricated tool-output placeholder.
- Publish the current synchronization result in the same device report instead of reporting the previous run.

## 0.1.0 - 2026-07-12

- Initial private repository baseline.
- Selected-conversation synchronization with per-device heads and canonical promotion.
- User-skill three-way synchronization and conflict preservation.
- Folder and private-Git transports.
- Windows/macOS bootstrap, scheduling, maintenance, health reporting, and recovery commands.
- Cross-platform end-to-end test suite.
