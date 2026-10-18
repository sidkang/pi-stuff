# 分享链接

## 创建分享

用户明确要求分享后，再选择文件 FID 和链接范围。分享会让持有链接的人访问文件，不把“找出来看看”解释为创建公开链接。

```bash
# 私密链接，7 天有效
./scripts/quark-drive.cjs share '<FID1>' '<FID2>' --url-type 2 --expired-type 3
```

| 参数 | 含义 |
|---|---|
| `--title <string>` | 可选分享标题 |
| `--url-type 1` / `2` | 公开 / 带提取码的私密链接 |
| `--expired-type` | 1 永久、2 一天、3 七天、4 三十天、5 六十天、6 一百天、7 一百八十天 |

按用户选择传入链接类型和有效期；需求未明确且影响公开范围时先询问，不假定公开永久分享。提取码由服务端生成，不自行编造。

成功后从 `result.data.share_url` 获取链接，以完整可点击 URL 交付；有 `passcode` 时一并提供。未取得最终成功结果不宣称链接已创建。手机号绑定、文件不可分享或分享数量限制等失败按 `msg` 处理，不反复创建链接。

## 查看分享内容

```bash
./scripts/quark-drive.cjs share-detail --url 'https://pan.quark.cn/s/SHARE_ID'
./scripts/quark-drive.cjs share-detail --url 'https://pan.quark.cn/s/SHARE_ID' --passcode '<提取码>'
./scripts/quark-drive.cjs share-detail --url 'https://pan.quark.cn/s/SHARE_ID' --page 2 --size 50
./scripts/quark-drive.cjs share-detail --url 'https://pan.quark.cn/s/SHARE_ID' --pdir-fid '<分享内目录FID>'
```

`--page` 默认 1，`--size` 默认 50，`--pdir-fid` 默认 `"0"`，表示**这个分享的顶层**，不是自己网盘的保存目标。URL 可带 `?pwd=提取码`；显式 `--passcode` 优先。

结果包含 `token_info`、`share_info`、`file_count` 和 `files`。每个文件包含 `fid`、`filename`、`size`、`file_type`、`category` 等；`file_type: "0"` 为文件夹，`"1"` 为文件。按需要翻页或进入子目录，不把当前页当作完整分享。分享令牌属于内部参数，不需要向用户展示。

## 分享内搜索

```bash
./scripts/quark-drive.cjs share-search --url 'https://pan.quark.cn/s/SHARE_ID?pwd=CODE' --keyword '报告' --page 1 --size 50
```

`share-search` 不提供独立 `--passcode` 参数，带提取码时放入 URL。结果为 `file_count` 和 `files`；页码默认 1，每页默认 50。这里得到的是分享内文件 FID，转存用法见[转存](file-saveas.md)，不要当作已经存在于自己网盘的文件。

虽然 SDK 的分享查询使用客态接口，当前 CLI 的全局认证检查仍可能要求登录；按实际认证错误处理，不承诺这些命令在未登录时可用。链接失效或提取码错误时核对链接，不通过重登或转存来绕过。
