# 演示

[English](demo.md) | **简体中文**

此演示使用合成路径与空白测试任务。

```text
$ sync2 conversation select current
Selected: Example task

$ sync2 sync
conversationsPushed: 1
conversationConflicts: 0

$ sync2 doctor
ok: true
```

在第二台设备上，第一次同步会导入稳定 canonical 快照，并更新该设备的本地 Codex 任务索引。第二次同步发布新的设备 head。随后所有健康 head 都应拥有相同 SHA-256 哈希。

运行 `npm run check` 可以进行可复现的本地模拟：它先扫描仓库中的敏感内容，再创建隔离的临时 Codex home 与 vault，且不会读取用户真实会话。
