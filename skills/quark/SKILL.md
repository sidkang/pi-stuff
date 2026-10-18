---
name: quark
description: "操作夸克网盘：检查登录、搜索、上传、下载、分享、转存、创建目录、移动文件；用户要求删除时用创建目录+移动做根目录 /待删除 下的可逆隔离（非永久删除）。用户明确指定夸克、提供 pan.quark.cn 分享链接，或继续已有夸克任务时使用；普通文件操作不默认选择夸克。"
compatibility: "Node.js 16+；登录和文件操作需要访问夸克开放平台。"
license: Apache-2.0
metadata:
  version: "1.0.15-safe"
  upstream:
    repo: quark-clouddrive/quarkclouddrive_offical
    path: skills/quarkclouddrive
    version: "1.0.15"
    status: modified
    notes:
      - local: scripts/install.sh only checks the local environment; it does not download archives, call remote configuration, or update files.
      - local: deletion moves files under the root /待删除 folder for reversible isolation instead of deleting them permanently.
      - local: add resumable batch uploads in scripts/lib/upload-batch.cjs and scripts/lib/upload-batch-cli.cjs.
---

# Quark

通过随附 CLI 操作夸克网盘，无需全局安装或 npm 依赖。以下命令路径均相对本 skill 目录。

```bash
./scripts/quark-drive.cjs <command> [options]
```

## 登录与调用

已有授权时直接执行任务，不必每次运行安装检查或登录。用户只想确认账号是否可用时，运行 `login`：它验证已有授权，有效即成功退出，不需要随机搜索文件来探测连接。没有有效授权时，该命令会进入浏览器授权流程，运行前说明这一点。

```bash
./scripts/quark-drive.cjs login
./scripts/quark-drive.cjs <command> --help
```

授权保存在 `~/.config/quark/config.json`。不要在回复或日志中展示访问令牌、授权码或配置内容，也不要把会话原文作为命令参数上传。此版本不提供远程更新；运行环境确实有问题时才用 `bash ./scripts/install.sh` 做本地检查，它不会安装或下载任何东西。

## 按任务阅读

- [授权](references/auth.md)：已有登录、浏览器授权、授权码和退出。
- [搜索](references/file-search.md)：查文件、选择 FID、读取完整结果。
- [上传](references/file-upload.md)：文件夹/多文件批次上传、去重续传、`upload status`/`reconcile` 与清理边界。
- [下载](references/file-read.md)：保存到本地、续传和任务记录。
- [分享](references/file-share.md)：创建链接、查看分享内容和分享内搜索。
- [转存](references/file-saveas.md)：整个分享或指定文件、目标目录和失败处理。
- [目录、移动与隔离删除](references/file-ops.md)：建目录、移动文件，以及用 `create-folder`+`move` 把文件隔离到根 `/待删除/<任务子目录>`（非永久删除）。

## 目标与授权边界

用户未指定网盘目标目录时，省略可选目录参数，让服务端决定默认位置；`"0"` 只用于用户明确选择根目录的情况。指定了目标就按目标执行：同名目录不明确或目录不存在时询问，不静默改存其他位置。FID 从用户提供值或命令结果获取，不猜测。

搜索或查看分享不等于授权上传、转存、创建分享或移动文件；用户已明确要求的连续操作可以直接衔接。覆盖本地文件与退出授权需取得对应确认。用户明确要求删除网盘文件时，按[隔离删除](references/file-ops.md)用创建目录+移动执行可逆隔离并先说明语义（不回收空间、非永久抹除）；范围或重复判定不清时先问清，不要推断。不要把源业务目录当成根上的 `待删除`。

## 判断结果

业务命令的 stdout 是逐行 JSON。以 **`type: "result"` 的 `code: 0` 和进程退出码 0** 判断完成；`progress`、单个成功的 `list` 条目或 100% 进度都不能替代最终结果。搜索的 `artifact` 行可能在 `result` 之后，不能只读最后一行。

失败时说明 `msg` 和当前已完成的部分。认证失效按授权页处理；网络中断或超时不等于远端未执行。上传先查同一批次的 `upload status`（或相同路径/`--batch-id` 续跑），对 `needs-reconciliation` 先核对再决定，勿整批重传。转存等其他写操作同样先核对结果或已有任务。仅按返回的路径报告保存位置，缺失时不推断为根目录。
