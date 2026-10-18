# 搜索与选择文件

## 搜索自己的网盘

```bash
./scripts/quark-drive.cjs search --keyword '年终报告'
./scripts/quark-drive.cjs search --keyword '旅行照片' --size 100
./scripts/quark-drive.cjs search --keyword '工作资料' --category 0
```

`--keyword` 最长 50 字符，保留用户提供的名称、主题和类型线索。`--size` 为 1–3000，默认 3000；不支持分页。`--category` 可限定类型：0 文件夹、1 视频、2 音频、3 图片、4 文档、5 种子、6 其他、7 压缩包、8 应用。没有明确类型筛选需求就省略。

先用最贴近用户意图的关键词。空结果不是错误，也不证明网盘不可访问；报告未找到匹配项。需要改词时依据用户补充或明确线索，不盲目反复搜索，更不把一次空结果解释为文件不存在。

## 展示结果

`result.data` 包含：

| 字段 | 用途 |
|---|---|
| `total` | 服务端匹配总数 |
| `file_list` | 最多 5 条预览，不一定包含全部匹配 |
| `check_all_link` | 查看更多结果的链接（如有） |
| `browse_hint` | 浏览器访问提示（如有） |

用紧凑表格展示文件名、大小或文件数量、类型及可用的查看链接。文件项使用 `filename`、`size`、`includeItems`、`category`、`check_link`；修改时间 `updated_at` 为毫秒时间戳。仅在存在 `big_thumbnail` 时添加缩略图列，不虚构缺失字段。

区分总数与预览条数；有 `check_all_link` 时提供完整可点击链接，并简要说明相关访问提示。纯搜索任务到展示结果为止，不自动创建分享或下载。用户原本就要求“找到后下载／分享／移动”时，可继续已授权的后续步骤。

## 获取完整结果与 FID

搜索有结果且落盘成功时，CLI 在 `result` 后追加 `artifact`：

```json
{"code":0,"msg":"成功","data":{"file_path":"/absolute/path/search-results.jsonl","count":100,"format":"jsonl"},"action":"search","type":"artifact"}
```

需要预览以外的匹配项、筛选同名目录或对整批结果操作时，读取 **本次返回的 `data.file_path`**。文件每行一个文件对象，没有 `code/type/data` 外壳，用其中的 `fid` 执行后续命令。只处理用户点名的预览条目时可直接使用该条目的 FID。

`artifact.count` 是实际返回并落盘的条数，受 `--size` 上限约束，可能小于 `total`。不要把 5 条预览或最多 3000 条已取回结果当作全部匹配。缺少 artifact 时，已有预览仍有效，但无法据此完成全量操作；说明限制，不悄悄只处理前几项。文件可能过期清理，不硬编码存储路径。

`--stdout-only` 只控制是否写展示卡片，不会取消搜索结果 artifact，也不保证把完整结果直接打印到 stdout。Pi 下无需依赖卡片来展示结果。

如果用户要分析文件内容，先定位文件，再按[下载](file-read.md)取得本地文件并使用相应阅读工具。本 CLI 不提供 `summary` 或 `qa`。
