# opencode-fish（实验）

OpenCode TUI 版的「单行摸鱼看书」。目前在 `feat/opencode-fish` 分支上，功能是 Pi 版的一个子集。

## 现在能做什么

- 在 **composer 上方**常驻一行：`⎿ 正文…… 42%`，配色用主题的 muted；
- `/fish <文件路径>` 打开 txt / epub（相对路径按当前项目目录解析）；
- `alt+j` / `alt+k` 或 `/fish-next` / `/fish-prev` 一行一行翻；
- `/fish-save` 手动保存；
- `/fish-close` 合上；`alt+m` / `alt+h` 显示/隐藏（或 `/fish-hide`、`/fish-show`）；
- 进度和 Pi 版**共用** `~/.pi/agent/fish/state.json`（或 `PI_CODING_AGENT_DIR` 指向的目录）：在 Pi 里读到 42%，切到 OpenCode `/fish` 打开同一本，就接在 42% 那一行；
- **实时同步**：两边都监听这个文件，对方翻页后这边大约 50ms 内跟到同一行；多个 OpenCode 窗口之间也一样；
- 启动时按 Pi 的 `resumeOnStart` 设置自动恢复上次的书；
- 写入走和 Pi 版同一套「锁 + 按书合并」，两边同时开不会互相回退不同书的进度；同一本书以最后保存为准（两边都在翻时会互相带着走）。

## 安装

```bash
cd packages/opencode-fish
npm install
```

在 `~/.config/opencode/cli.json` 里加上这个目录（用绝对路径）：

```json
{
  "plugins": ["D:/code-gh/xy-coder-cli/pi-fish/packages/opencode-fish"]
}
```

然后重开 OpenCode TUI 或 `/reload`。

## 命令

| 命令 / 键 | 作用 |
|---|---|
| `/fish <path>` | 打开书 |
| `alt+j` / `/fish-next` | 下一行 |
| `alt+k` / `/fish-prev` | 上一行 |
| `/fish-save` | 立即保存 |
| `/fish-close` | 合上 |
| `alt+m` / `alt+h` | 显示 / 隐藏 |
| `/fish-hide` / `/fish-show` | 隐藏 / 显示 |

## 已知限制

- **没有鼠标翻页**：OpenCode TUI 插件 API 没有暴露鼠标事件，只能键盘/命令；
- **还没有多行阅读模式**：现在只有常驻一行；
- 同一本书两边同时读时，以最后保存的为准（和 Pi 多开一样）；
- 这个 spike 早期版本用 OpenCode 自带 storage 存过测试进度，那部分不会自动迁移；现在统一以 Pi 的 `fish/state.json` 为准；
- 引擎暂时通过相对路径复用 Pi 包的 `src/reader.ts` / `src/paging.ts` / `src/state.ts`（纯 TypeScript，没有 Pi 依赖）。等交互验证完，会把引擎抽到 `packages/core`，两个插件共用；
- 宽度固定 66 列，窄终端可能折行。

## 结构说明

Pi 版仍在仓库根目录（`package.json` + `src/`），这样你现有的 Pi 加载路径不会断。OpenCode 版放在 `packages/opencode-fish`，是将来完整 monorepo（`packages/core` + `packages/pi-fish` + `packages/opencode-fish`）的第一块。
