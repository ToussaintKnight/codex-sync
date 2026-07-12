# Demonstration

This demonstration uses synthetic paths and an empty test task.

```text
$ sync2 conversation select current
Selected: Example task

$ sync2 sync
conversationsPushed: 1
conversationConflicts: 0

$ sync2 doctor
ok: true
```

On a second device, the first sync imports the stable canonical snapshot and updates that device's local Codex thread indexes. A second sync publishes the new device head. All healthy heads then have the same SHA-256 hash.

For a reproducible local simulation, run `npm test`; it creates isolated temporary Codex homes and vaults and never reads the user's real conversations.
