# 下载到本地

## 下载文件

```bash
./scripts/quark-drive.cjs download --fid '<文件FID>' --output-dir '/absolute/output/dir'
```

当前 CLI 使用 `download`，不提供 `read-file`。一次下载一个 FID；多个文件按已选定的列表逐个处理，分别保留结果。不要把目录 FID 当作可递归下载的文件。

`--output-dir` 默认是工作目录下的 `./downloads`；用绝对路径明确目的地，目录不存在时 CLI 会创建。默认遇到同名文件自动改名，只有用户同意覆盖时才加 `--overwrite`。

成功的 `result.data` 返回 `fileName` 与 `filePath`。以实际 `filePath` 报告本地位置。下载完成不代表已经读取或理解内容；分析任务还需要用合适的工具打开该文件。

## 查看和恢复任务

```bash
./scripts/quark-drive.cjs download list
./scripts/quark-drive.cjs download list --state paused
./scripts/quark-drive.cjs download resume --record-id '<任务ID>' --output-dir '/original/output/dir'
```

列表逐条返回 `recordId`、`fileName`、`fileSize`、`state`，最终结果给出 `totalCount`。可按 `pending`、`paused`、`failed`、`completed` 筛选。

SIGINT 会让 CLI 尝试保存断点；强制结束不保证保存。恢复前核对任务和原下载文件，使用原输出目录。`resume` 没有自动重命名的保护，尤其要检查初次下载因同名冲突改名的情况，不要让恢复写入无关的同名文件。任务或部分文件不匹配时先停止核对。

## 清理任务记录

```bash
./scripts/quark-drive.cjs download delete --record-id '<任务ID>'
```

这删除的是持久化任务记录，不是网盘文件；也不能作为已删除本地下载文件的凭据。仅按用户要求清理选中的记录。下载内容若只是本次分析产生的临时文件，按已约定范围清理，不删除用户原有文件。

## 失败处理

没有最终成功结果时不声称下载完成。常见错误包括获取下载链接失败（`-302`）、创建任务失败（`-303`）、下载失败（`-305`）和恢复失败（`-309`）；服务端错误也可能直接透传。依据 `msg` 区分认证、文件权限、网络与本地写入问题；中断后先查任务，不盲目重新下载。
