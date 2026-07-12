# Changelog

**English** | [简体中文](CHANGELOG.zh-CN.md)

All notable changes are documented here.

## Unreleased

- Rewrite the README around user pain, executable proof, and ecosystem positioning.
- Add paired English/Simplified Chinese README, trust, demo, roadmap, and architecture documents.
- Add a repository-native sensitive-information gate to local checks and CI.
- Upgrade GitHub Actions runtimes to their current Node 24-based major versions.
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
