# 上传与续传

上传默认走**本地批次层**：同一来源与目标会落到同一个 batch，避免把已成功文件再传一遍。这不声称服务端 exactly-once，也不修复 SDK ACK 超时根因；目标是失败/中断后可恢复且不制造重复。

## 上传文件或文件夹

```bash
./scripts/quark-drive.cjs upload '/absolute/path/file.zip'
./scripts/quark-drive.cjs upload '/absolute/path/folder'
./scripts/quark-drive.cjs upload '/path/a.txt' '/path/b.pdf' --parent-fid '<目录FID>'
```

文件夹会递归上传并保留相对目录结构。用户没有指定网盘目录时省略 `--parent-fid`，由服务决定默认位置；一旦批次得知实际父目录 FID 会钉住，不会在重试时静默改存到根目录。

普通重试请使用**相同路径与相同 `--parent-fid`（含省略）**。CLI 会匹配已有未完成批次并继续，而不是静默新建整批：

```bash
./scripts/quark-drive.cjs upload '/absolute/path/folder' --parent-fid '<目录FID>'
./scripts/quark-drive.cjs upload '/absolute/path/folder' --batch-id '<batchId>'
```

已有**完成**批次且确实要整批再传时，才用显式开关：

```bash
./scripts/quark-drive.cjs upload '/absolute/path/folder' --parent-fid '<目录FID>' --new-batch
```

存在未完成/未知结果/多个可匹配批次时，命令会失败并要求 `--batch-id` 继续指定批次；`--new-batch` **不能**绕过这些开放批次。仅当匹配批次已全部完成（或没有匹配）时，`--new-batch` 才可新建。

执行前确认本地路径存在且属于用户要求上传的范围。按规模选择运行时间；Pi `bash.timeout` 以秒计。长任务应保留完整 stdout/批次事件，不要依据被截断的终端预览推断失败清单。

## 判断完成

批次层会节流终端进度（约 1 次/秒），但把逐文件证据写入批次清单与事件日志。关键输出：

| 输出 | 关键字段 | 含义 |
|---|---|---|
| `progress` | `batchId`、`current`、`total` | 节流后的进度，不代表最终完成 |
| 成功的 `list` | `batchId`、`recordId`、`fileId`、`relativePath`、`instantUpload` | 单文件成功；`instantUpload` **不是**跨次去重依据 |
| 失败的 `list` | `recordId`、非零 `code`、`msg` | 单文件失败 |
| `result` | `batchId`、`status`、`counts`、`fids`、`manifestPath`、`eventsPath` | 批次汇总 |

以最终 `result` 与进程退出码为准：

- `0`：批次内文件均已确认成功
- 非 0：查看 `status` / `counts`；`needs-reconciliation` 表示有未知结果，**不要**当失败清单直接整批重传

## 状态、恢复与核对

```bash
./scripts/quark-drive.cjs upload status --batch-id '<batchId>'
./scripts/quark-drive.cjs upload batches
./scripts/quark-drive.cjs upload '/absolute/path/folder' --batch-id '<batchId>'
./scripts/quark-drive.cjs upload reconcile --batch-id '<batchId>'
```

语义：

- 已确认成功且源文件 size/mtime/**内容摘要**未变：跳过
- 已确认成功后源文件变更（含同长度并恢复 mtime 的改写）：该文件重新进入待传，并保留先前 `remoteFid` 证据；其他成功项保留
- 仍绑定未知/在途效果（`recordId` / `remoteFid` / `uploading` / `needs-reconciliation`）时源文件再变：保留原摘要与任务/FID 证据，标记 `needs-reconciliation`，**拒绝**自动 `restoreTask` 或新建；重复命令保持同一判定。`upload reconcile` 也不会仅因旧 remote FID 仍在就把新字节标成已上传
- 账号或目标（`--parent-fid`）不一致：隔离到其他批次，不混用；`upload status` / `upload batches` / `upload reconcile` 也只对**当前账号**的批次可见，外账号 `--batch-id` 直接拒绝
- 已有 `recordId` 且结果未知、源未变：优先 `restoreTask` 续传，不新建任务
- 无 `recordId` / 无 `remoteFid` 的未知结果：停在 `needs-reconciliation`，给出清单与证据路径
- 首次匹配/创建批次时，按账号+源根+目标加解析锁，避免两进程同时「未见匹配」而各建一批；每批运行仍另有 runner 锁。陈旧锁失败关闭，不自动抢占
- SDK `upload().start()` 是管理器全局启动（会排空队列里所有 pending 任务）。批次适配器只在本批有选中 `recordId` 时启动；若队列里还有**外批 pending** 任务则失败关闭，避免误启动无关上传。本批零任务时不调用全局 `start`
- `upload reconcile`：**只**对批次已记录的 remote FID 调用 `getFileInfo` 核对。当前未接入可安全证明身份的远端目录列举；**文件名+大小不能当证明**。越界项保持待人工处理，不会自动再传

目录创建同样落盘。若在 `creating` 中断、或 `createFolder` 在发出创建意图后抛错且尚未钉住 FID，批次会 `needs-reconciliation`，拒绝再次 `createFolder` 以免叠目录（远端可能已建成）。

参数错误、未登录会直接停批，不盲重试。

## SDK 任务级命令（单文件记录）

批次层之外，SDK 仍保留单任务记录命令：

```bash
./scripts/quark-drive.cjs upload list
./scripts/quark-drive.cjs upload list --state paused
./scripts/quark-drive.cjs upload resume --record-id '<任务ID>' --file-path '/original/path/file.zip'
./scripts/quark-drive.cjs upload delete --record-id '<已完成任务ID>'
```

主动中断优先 SIGINT。`upload delete` 只删本地任务记录，不是删远端文件或源文件。批次成功清单在 `manifestPath`；清理 SDK 记录前先保留批次证据。不要自动删除源文件、缓存目录或未确认的任务记录。
