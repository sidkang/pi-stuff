# 转存分享

将分享内容保存到自己的网盘，不下载到本地。用户只发来链接但未说明用途时，先确认是查看还是转存，不默认保存整个分享。

## 整个分享或指定文件

```bash
./scripts/quark-drive.cjs saveas --url 'https://pan.quark.cn/s/SHARE_ID'
./scripts/quark-drive.cjs saveas --url 'https://pan.quark.cn/s/SHARE_ID' --fid-list 'FID1,FID2'
./scripts/quark-drive.cjs saveas --url 'https://pan.quark.cn/s/SHARE_ID' --passcode '<提取码>'
```

默认转存整个分享；`--save-all` 只是显式表达这个选择，不能与 `--fid-list` 同用。部分转存的 FID 应来自该分享的详情或搜索结果，必要时先翻页定位。CLI 自动取得分享令牌。

URL 支持 `?pwd=提取码`，显式 `--passcode` 优先。

## 目标目录

```bash
./scripts/quark-drive.cjs saveas --url 'https://pan.quark.cn/s/SHARE_ID' --to-pdir-fid '<目录FID>'
./scripts/quark-drive.cjs saveas --url 'https://pan.quark.cn/s/SHARE_ID' --to-pdir-path '/我的文件/资料'
```

FID 与路径选择一种。用户提供明确路径时可直接传 `--to-pdir-path`；只有目录名时先按[搜索](file-search.md)定位并消除同名歧义。用户明确选择根目录时传 `--to-pdir-fid '0'`。未指定目标时省略两个参数，使用服务端默认位置。

指定目录不存在或无法确定时，询问是否创建或改用其他位置；**不要省略用户指定的目标而静默转存到默认位置**。CLI 帮助或旧文档中的“默认根目录”不能代替服务端实际结果。

## 完成与失败

转存会轮询远端任务，当前 CLI 最多等待约 15 分钟。Pi 工具超时按秒设置，需覆盖该等待时间；没有持续进度输出不代表任务未运行。

只有最终 `result.code: 0` 且进程成功退出才报告完成。结果可能包含 `task_id`、任务 `status`、`save_as` 和 `save_path`。使用返回的具体目录信息；`save_path` 若只有“来自：分享”这类标签，不当作完整路径，也不据此推断根目录。

失败时说明 `msg`，保留已返回的任务标识。`32003` 或 `32004` 表示空间不足，先处理容量，不自动重试。分享失效、权限不足或提取码错误时修正对应输入。轮询超时后远端任务可能仍在运行，先核对网盘中的结果，再决定是否重新转存，避免重复保存。
