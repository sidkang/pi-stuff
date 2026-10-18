# JJ 工作流参考

本文是日常 Jujutsu 操作的按需参考。遇到 conflict、recovery、workspace、remote/Gerrit、divergence 或内容移动时，从 `SKILL.md` 的指针进入本文件。`pi-jj-anchor` 的 workspace 架构笔记位于 [`plugins/pi-jj-anchor/docs/workspace-design.md`](../../../plugins/pi-jj-anchor/docs/workspace-design.md)。

## 来源

- Steve Klabnik, *Steve's Jujutsu Tutorial*（已阅读 print 版完整教程）
  - https://steveklabnik.github.io/jujutsu-tutorial/introduction/introduction.html
  - https://steveklabnik.github.io/jujutsu-tutorial/real-world-workflows/the-squash-workflow.html
  - https://steveklabnik.github.io/jujutsu-tutorial/advanced/simultaneous-edits.html
- Joshua Lyman, *Demystifying Jujutsu (jj) Workspaces*
  - https://www.joshualyman.com/2026/02/demystifying-jujutsu-jj-workspaces/
- Official docs
  - https://docs.jj-vcs.dev/latest/tutorial/
  - https://docs.jj-vcs.dev/latest/gerrit/
  - https://docs.jj-vcs.dev/latest/guides/divergence/

## 1. 基础单 change 工作流

适合小任务或线性修改。

```bash
jj status
jj describe -m "feat: describe work"
# edit files
jj diff
jj new -m "next task"
```

注意：

- 如果 `@` 有未完成/无关改动且必须继续作为最新工作区，先检查图并请求确认。确认后记录其 change ID，再用 `jj new -B @ -m ...` 在它之前插入 task change；完成 task 后用 `jj edit <原 change ID>` 切回，并用 `jj status` 与 `jj log -n 5` 确认 task 是父 change、原工作区仍是最新 `@`、没有意外 conflict。
- 如果 `@` 是空 commit，可以直接 `jj describe -m ...` 把当前 change 命名。
- 不需要为了“保存”而 commit；`jj` 的 working-copy commit 已经是 repo 中的 revision。

## 2. Squash workflow

Steve 教程和官方教程都把它作为重要工作流。它类似 Git index，但对象是 commit，不是 staging area。

典型流程：

```bash
# 1. 先创建/描述“真实 change”
jj describe -m "feat: implement X"

# 2. 在上面创建一个空 scratch @
jj new

# 3. 在 scratch @ 里随意编辑
jj diff

# 4. 把想保留的内容移动进父 change
jj squash              # 全部 squash 到 @-
jj squash path/to/file # 只移动某些文件
jj squash -i           # 交互式选择 hunks/lines
```

适合：

- 喜欢 Git index / `git add -p` 的人；
- 想先在 scratch commit 里试错，再把干净部分放入真实 change；
- 需要把 agent 的临时修改整理成较小、清晰 change。

注意：

- 默认 `jj squash` 是从 `@` 移到 `@-`。
- 交互式 `jj squash -i` 可以选择部分 hunk，能力比 Git index 更正交。
- squash 后 `@` 可能变成空 scratch commit，这是正常的。
- 如果 scratch 内容不要了，用 `jj abandon` 丢弃当前 change；这是 destructive，操作前应确认。

## 3. Edit workflow

另一种常见方式是直接在目标 change 上工作，需要拆分时再插入/编辑其他 change。

典型流程：

```bash
jj new -m "feat: implement X"
# edit files directly in this change

# 发现需要在当前 change 之前插入一个 change
jj new -B @ -m "refactor: prepare Y"
# edit inserted change

# 回到原 change
jj edit <change-id>
# or use navigation commands such as jj next / jj prev if configured/available
```

适合：

- 任务边界清晰，愿意直接修改目标 change；
- 后续发现需要拆前置 refactor 或拆分提交；
- stacked PR / patch stack 工作流。

注意：

- `jj new -B @` 会在当前 change 前插入新 change，并自动 rebase descendants。
- 被 rebase 的 change ID 保持不变，但 commit ID 会变化。
- 如果需要保守 review 当前新修改，squash workflow 更直观；如果 change 已接近完成，edit workflow 更直接。

## 4. Anonymous branch / stacked change 工作流

`jj` 不要求本地每条分支都有名字。两个 change 共享同一个 parent，就形成分支。

```bash
jj new <base> -m "feat: A"
# edit A

jj new <base> -m "feat: B"
# edit B

jj log -r 'heads(all())'
```

适合：

- 同时尝试多个方向；
- 维护 stacked changes；
- 不想为每个本地实验创建 Git branch/bookmark。

注意：

- 用 description + change ID 区分匿名分支。
- `jj log -r 'heads(all())'` 可以查看当前所有 head。
- 常用 revsets：
  - `@` 当前 working-copy commit；
  - `@-` parent；
  - `::@` ancestors；
  - `@::` descendants；
  - `A..B` 在 B 中但不在 A 中；
  - `trunk()..@` 当前 stack 相对 trunk 的 commits。

## 5. 同时编辑多个分支 / 自动 rebase 工作流

Steve 的 simultaneous-edits 章节强调：`jj` 允许你在多个 branch/stack 上同时工作，并把新 upstream changes 或前置修改 rebase 到所有相关分支。

典型思想：

```bash
# 多个 feature head 同时存在
jj log -r 'heads(all())'

# 对一个前置 change 做修改
jj edit <base-change>
# edit files

# descendants 自动 rebase 到更新后的 base
jj log
```

适合：

- 多个 PR/feature 共享同一前置 refactor；
- parallel agent 分别修改不同 workspace 后，最终统一整理；
- orchestrator workspace / megamerge 试验。

注意：

- 自动 rebase 不代表没有冲突；冲突会成为 commit 状态。
- 工作流强依赖 change ID 稳定性。
- 插件如果保存 commit ID，要意识到 rewrite 后旧 commit ID 可能过时；保存 change ID 更适合作为“长期身份”。

## 6. Conflict 工作流

`jj` 的 rebase/merge 遇到冲突仍会完成，conflict 会记录在 commit 上。

常见流程：

```bash
jj rebase -r <change> -d <dest>
# 如果产生 conflict，先查看 log/status
jj status
jj log

# 推荐方式：在冲突 commit 上创建 resolution commit
jj new <conflicted-change>
# edit conflict markers or run jj resolve
jj diff
jj squash  # 把 resolution squash 回 conflicted change
```

简化方式：

```bash
jj edit <conflicted-change>
# 直接编辑冲突文件
jj status
```

注意：

- `jj` conflict markers 比 Git 更丰富，可能包含 snapshot 和 diff 信息。
- 官方教程推荐复杂冲突用“new resolution commit -> review -> squash”的方式，便于检查。
- 解决父 commit 的冲突后，descendants 可能自动变为已解决。

## 7. Operation log / recovery 工作流

本地危险操作前后都应记得：

```bash
jj op log
jj undo
jj log --at-op <operation-id>
jj status --at-op <operation-id>
```

适合：

- squash/rebase/abandon 后发现结果不对；
- conflict resolution 走错；
- 插件自动化误操作后的恢复。

注意：

- `jj undo` 回滚本地 operation，不等于撤销已 push 的远程状态。
- 自动化执行复杂 history 操作前，应尽量记录/展示 operation id，或提示用户可用 `jj op log` 恢复。

## 8. GitHub / Git remote 工作流

本地可以尽量匿名，发布时再使用 bookmark。

```bash
jj git clone <url>
jj git fetch
jj bookmark create <name> -r <rev>
jj bookmark move <name> --to <rev>
jj git push -b <bookmark>
```

PR feedback 常见处理：

```bash
# 在当前 PR change 上追加修改
jj edit <change-id>
# edit files

# 或者开 scratch，再 squash 回 PR change
jj new <change-id>
# edit files
jj squash
```

注意：

- bookmark 不会像 Git branch 那样自动跟着 `@` 移动；需要显式 move。
- push 前确认 bookmark 指向正确 revision。
- stacked PR 场景下，rebase 前后 change ID 稳定，但 Git commit hashes 会变化。

## 9. Gerrit 工作流

官方 Gerrit guide 的核心：JJ change identity 与 Gerrit Change-Id 心智模型相近，`jj gerrit upload` 负责桥接。

基本设置：

```bash
jj git init                         # existing Git/Gerrit repo
jj git remote add gerrit <url>       # if needed
jj config set --repo gerrit.default-remote gerrit
jj config set --repo gerrit.default-remote-branch main
```

上传：

```bash
jj gerrit upload          # 默认上传 @ 或 @-
jj gerrit upload -r @-
jj gerrit upload -r A..B
jj gerrit upload --dry-run -r @-
```

注意：

- 每个 JJ change 通常对应一个 Gerrit change。
- Gerrit 用 commit message 中的 `Change-Id` trailer 关联 patch sets；`jj gerrit upload` 会处理这个桥接。
- 如果要关联已有 Gerrit change，可复制 Gerrit 的 Change-Id footer 到 JJ description。
- 用 `--dry-run` 预览要上传哪些 revisions。

## 10. Workspace 工作流

Workspace 是同一个 jj repo 的多个 working copies。它们 filesystem 独立，但共享 commits/history。

Joshua Lyman 的 workspace 文章总结得很清楚：

```text
workspace A: 独立目录、独立 working-copy commit
workspace B: 独立目录、独立 working-copy commit
shared repo: 同一个 DAG/history/store
```

创建：

```bash
# 最好先让 main workspace 位于合适 base/scratch commit
jj new
jj workspace add ../repo.feature --name feature

# 或从指定 revision 创建
jj workspace add ../repo.feature --name feature -r <rev>
```

典型用途：

- 一个 workspace 跑长测试，另一个继续开发；
- 为 AI agents 分配隔离 sandbox；
- 对比不同 revision 的实际文件树；
- 多个 feature 并行开发，再通过 rebase/squash/merge 整理。

整合：

```bash
# 把 feature workspace head rebase 到 main workspace head 后面
jj rebase -r <feature-workspace>@ -d <main-rev>

# 或让 main workspace 跳到某个结果
jj edit <feature-workspace>@

# 完成后清理 workspace 记录和目录
jj workspace forget <workspace-name>
rm -rf <workspace-dir>
```

注意：

- Workspace 目录不要放在 repo 内部，优先做 sibling 或 cache path，避免 repo-in-repo 混乱。
- `jj workspace forget` 不会删除目录；删除目录也不会自动 forget workspace。
- 一个 workspace 的文件改动只有在该 workspace 内运行 `jj` 命令（如 `jj util snapshot`、`jj status`）后，才会进入共享 DAG。
- 因此跨 workspace review/list 前要主动 snapshot 目标 workspace。
- 跨机器同步时，workspace path 是本机路径，不应作为跨机器真相。

## 11. Divergent changes 工作流

官方 divergence guide 定义：多个 visible commits 共享同一个 change ID，就出现 divergent change。常见原因：

- 两个用户或进程同时修改同一 change；
- 同一个 repo 的多个 workspaces 对同一 change 进行 rewrite；
- fetch 回来一个基于旧 hidden predecessor 的 descendant；
- 手动把 hidden commit 重新变 visible。

处理策略：

```bash
# 保留一个，丢弃另一个
jj abandon <unwanted-commit-id>

# 两个版本都要保留为独立 change
jj metaedit --update-change-id <commit-id>

# 合并两个版本内容
jj squash --from <source-commit-id> --into <target-commit-id>

# 暂时不处理也可以，但 change ID 会变得不明确，需要用 /0 /1 或 commit ID 指定
jj log
```

注意：

- divergent change 不是立即错误，但会让 change ID 引用变 ambiguous。
- 多 workspace/多 agent 自动化应避免多个 workspace 同时编辑同一个 change ID；更推荐每个 agent workspace 从共同 base 创建自己的 working-copy commit。
- 自动化不应自行执行 `metaedit --update-change-id`；这是用户级 history 操作。

## 12. Split / diffedit / content movement

官方教程还介绍了更细粒度的内容移动：

```bash
jj split -i
jj squash -i
jj diffedit -r <rev>
```

适合：

- 把一个 agent 的大修改拆成多个 logical changes；
- 把修复 hunk 移到更早的 commit；
- 维护 clean stack。

注意：

- `jj split` 会把一个 revision 拆成 selected/remaining 两部分。
- `jj squash -i` 适合把当前/子 commit 的部分内容移入 parent。
- `jj diffedit` 可以不 checkout 目标 revision 直接编辑其 diff，但可能给 descendants 产生 conflicts。

## 操作前检查清单

在任何自动化 history 操作前：

```bash
jj status
jj log -n 10
jj op log -n 5
```

高风险操作需用户确认：

- `jj abandon`
- `jj restore`
- `jj squash` / `jj split` / `jj diffedit` 非当前 scratch 场景
- `jj new -B` / `--insert-after` 会重挂已有 change 时
- `jj rebase` 多 revision 或跨 workspace 场景
- `jj metaedit --update-change-id`
- `jj workspace forget`
- bookmark move/delete
- push / Gerrit upload

完成后验证：

```bash
jj status
jj log -n 10
jj diff
```
