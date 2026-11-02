# fish — 在 AI CLI 里摸鱼看书

在 **Pi** 和 **OpenCode** 的界面里读本地小说：平时缩成一行灰字，混在工具输出里；想看多行就打开阅读模式。书和进度都在本地，不注册 LLM 工具，不进模型上下文。

```
   ⎿  陈平安蹲在泥瓶巷的墙根下，看着檐下那串风铃发呆。风一吹，铃声很轻     7%
```

> 本文档对应 `feat/opencode-fish` 分支。`main` 只有 Pi 版，详见下面的分支说明。

## 分支说明

| 分支 | 内容 | 适合 |
|---|---|---|
| `main` | Pi 插件（仓库根目录） | 只想在 Pi 里用 |
| `feat/opencode-fish` | Pi 插件 + OpenCode TUI 插件（`packages/opencode-fish`） | 想 Pi / OpenCode 一起用，或想试实时进度同步 |

- `main` 是稳定线；`feat/opencode-fish` 是当前开发线，多了 OpenCode 版、`alt+h`、跨 CLI 实时同步。
- OpenCode 版目前是**实验性**的：只有常驻一行 + 键盘翻页，没有鼠标和多行阅读模式。
- 分支还没合并回 `main`。
- 以后会迁成完整 monorepo：`packages/core` + `packages/pi-fish` + `packages/opencode-fish`，然后分别发布 npm。现在为了不破坏本机 Pi 的加载路径，Pi 包仍在仓库根目录。

## 安装

### Pi（`main` 或本分支）

```bash
git clone https://github.com/JG1848244690/pi-agent-cli-fish-plugin.git
pi install D:\path\to\pi-fish
```

发布到 npm 之后也可以：

```bash
pi install npm:pi-fish
```

第一次启动：

```bash
/fish-add D:\books\剑来.txt     # 加一本 .txt
/fish-add D:\books\剑来.epub    # 或 .epub
/fish-add D:\books              # 或整个文件夹
/fish                           # 接着上次的位置，进阅读模式
```

`/fish-add` 不带参数会弹路径输入框，默认填上次所在目录。

**第一次启动会把自带的《手册》放进书架**（只加一次）：整篇 [TUTORIAL.md](TUTORIAL.md) 会生成成一本 10 章的电子书（`~/.pi/agent/fish/手册.md`）。书库为空时 `/fish` 直接打开它；已经有书就照常读，手册留在书架里。`TUTORIAL.md` 更新后会自动重新生成。

### OpenCode（仅本分支）

```bash
git switch feat/opencode-fish
cd packages/opencode-fish
npm install
```

在 `cli.json`（Windows 通常是 `C:\Users\<你>\.config\opencode\cli.json`）里加：

```json
{
  "plugins": ["D:/path/to/pi-fish/packages/opencode-fish"]
}
```

重启 OpenCode TUI（插件源码变化时热重载不一定重新加载模块），然后：

```
/fish D:\books\剑来.txt
```

## 进度共享与实时同步

Pi 和 OpenCode **共用同一个进度文件**：

```
~/.pi/agent/fish/state.json
```

（如果设置了 `PI_CODING_AGENT_DIR`，两边都用那个目录。）

- 每次翻页、跳章、开书、`/fish-save` 都会写盘；
- 写盘流程：加锁 → 读盘 → 按每本书的 `updatedAt` 合并 → 临时文件原子替换；
- 不同书的进度互不覆盖；书库取并集；配置只覆盖自己改过的字段；
- 两边都监听这个文件：**一边翻页，另一边约 50ms 内跟到同一行**；
- 同一本书两边同时不停翻时会互相带着走，最终以最后保存为准；
- 被同步的一方只移动显示位置，不会反向写盘，所以不会无限来回。

当前只做**同一台机器**。跨设备同步（云盘 / 自建服务）还没做，详见文末路线。

> 插件以前叫 `moyu`，旧目录 `~/.pi/agent/moyu/` 会在 Pi 启动时自动搬到 `fish/`，书架和进度都保留（只搬一次）。

## Pi 用法

Pi 版有两种形态：

| 形态 | 出现方式 | 显示 |
|---|---|---|
| 常驻行 | 一直在，`alt+m` / `alt+h` 隐藏 | **永远只有 1 行**，无标题、无边框，行尾一个总进度百分比 |
| 阅读模式 | `/fish` 或 `/fish-read` | 多行（默认 15 行），键盘直接翻页 |

### 常驻行

- 正文最长 66 列，整行 78 列；终端太窄时进度百分比自动让位；
- 鼠标：左键 = 下一行；双击 = 下一屏；右键 / 中键 / `shift`+左键 = 上一行（双击 = 上一屏）；滚轮 = 一行一格；`alt`+滚轮 = 一屏；
- 键盘：`alt+j` 下一行，`alt+k` 上一行（不要用 `ctrl+shift+字母`，终端会把它当成回车/删行）；
- `/fish hide` / `/fish show` 隐藏/恢复；
- `/fish auto 8` 每 8 秒自动下一行；`/fish auto off` 停；
- 百分比按**全书字符**算，和终端宽度无关：常驻行、阅读模式、书架、搜索结果、`/fish status` 都是同一个数；读完固定 100%。

> 鼠标只在 Pi 全屏模式（默认 `tuiMode: fullscreen`）下可用；老式 regular（inline）模式下用 `alt+j` / `alt+k`。
>
> 有些终端会扣住右键：VS Code 集成终端默认右键弹菜单/粘贴；Orca 自带终端在 Windows 上默认「右键粘贴」（设置 → Terminal → Right-click to paste），而且没有“转发给应用”的选项。这种情况用**中键**、`shift`+左键、滚轮上滚或 `alt+k`。
>
> Orca 还会把一个滚轮格的像素位移拆成多条滚轮事件重放；插件会把同一时刻、同方向的连续事件合并成一次翻页。

### 阅读模式

`/fish` 打开，占住键盘：

| 按键 | 作用 |
|---|---|
| `space` / `j` / `→` / `↓` / `PageDown` / 左键点击 | 下一页 |
| `k` / `←` / `↑` / `PageUp` / 右键 / `shift`+左键 | 上一页 |
| 滚轮 / `alt`+滚轮 | 一页 / 一章 |
| `]` / `[` | 下一章 / 上一章 |
| `/` | 打开搜索悬浮窗（同 `/fish-find`） |
| `n` / `N` | 下一处 / 上一处匹配 |
| `a` | 开关自动翻页（8 秒/页） |
| `b` | 老板键：阅读器和常驻行一起消失 |
| `q` / `esc` | 退出阅读，常驻行停在当前位置 |

行数：`/fish reader-lines 12`（默认 15）。

### 悬浮窗：书架 + 搜索

一个悬浮窗，两个模式，`tab` 切换：

- **书架**：打字过滤书名，点一本就打开它，并直接切到搜索模式；
- **搜索**：全文搜当前这本书，边打边出结果，选一条跳过去。

```
/fish-list            打开书架
/fish-find 陈平安     搜索，选一条直接跳过去
/fish-find            搜索（关键词留空从头找）
/fish-find off        去掉高亮，就地继续读
```

细节：

- 书架每行显示：`*` 当前书、进度百分比、章节号；
- 搜索一次最多显示 5 条，`↑`/`↓` 或滚轮选择，`⏎` 或鼠标点击跳转；
- 跳转落在**真正包含命中的那一行**，不是段落开头；
- 命中词高亮；`/fish-find off` 取消；
- 一本书最多收集 500 处命中，标题显示 `60+` 提醒换更长关键词；
- 从当前阅读位置往后找，到底自动绕回开头；
- 跳转后常驻行和阅读模式都会跟到命中行；阅读模式里命中词保持高亮，`/fish-find off` 取消。

### 命令

```
/fish-add [file|folder]     加书；省略参数弹出路径输入框
/fish                       继续上次的书并进入阅读模式
/fish-read                  进入阅读模式（同 /fish）
/fish-save                  立即保存当前阅读进度
/fish-find [关键词|off]      搜索悬浮窗；off 去掉高亮
/fish-list                  打开书架
/fish next [n] / prev [n]   常驻行前进/后退 n 行
/fish chapter / back-chapter
/fish auto 8                自动翻页；/fish auto off 关闭
/fish hide / show           老板键
/fish reader-lines 12       阅读模式行数
/fish resume off            关掉「启动自动恢复上次阅读」
/fish status                当前进度、章节、文件名
/fish close                 合上书并移除常驻行
```

全局快捷键：

| 键 | 作用 |
|---|---|
| `alt+m` / `alt+h` | 显示 / 隐藏常驻行 |
| `alt+j` / `alt+k` | 下一行 / 上一行 |
| `alt+n` | 下一处搜索命中（没搜索时打开搜索窗） |

> 用 `alt+字母` 而不是 `ctrl+shift+字母`：终端没有 Kitty 键盘协议时，`ctrl+shift+j` 会被当成 `ctrl+j`（换行）、`ctrl+shift+k` 当成 `ctrl+k`（删到行尾），把输入框弄坏。

## OpenCode 用法

目前只有常驻一行，显示在 composer 上方。

| 命令 / 键 | 作用 |
|---|---|
| `/fish <path>` | 打开书；不带参数恢复上次的书 |
| `alt+j` / `/fish-next` | 下一行 |
| `alt+k` / `/fish-prev` | 上一行 |
| `/fish-save` | 立即保存 |
| `/fish-close` | 合上（进度保留） |
| `alt+m` / `alt+h` | 显示 / 隐藏 |
| `/fish-hide` / `/fish-show` | 隐藏 / 显示 |

限制：

- 没有鼠标翻页（OpenCode TUI 插件 API 不暴露鼠标事件）；
- 没有多行阅读模式；
- 宽度固定 66 列；
- 进度与 Pi 共享，实时跟随。

## 隐蔽性设计

- **常驻就是一行**：无标题、无边框，正文最长 66 列，行尾只有一个百分比；
- **不注册 LLM 工具**：正文永远不进模型上下文，不花 token；
- **不写 Pi 会话**：书库和进度在 `~/.pi/agent/fish/state.json`，会话记录里没有书名和路径；
- **老板键是真空的**：阅读模式里 `b` 直接销毁阅读器和常驻行；`alt+h` / `alt+m` 也可以只隐藏常驻行；
- 命令描述都是中性的（"Add a local text file or folder"）。

## 项目结构

```
.
├── src/                      Pi 插件的源码（根目录包）
├── packages/
│   └── opencode-fish/        OpenCode TUI 插件（实验）
├── test/                     Pi 引擎/组件测试
├── TUTORIAL.md               Pi 内置《手册》的源文件
└── package.json              Pi 包定义 + 测试脚本
```

| 文件 | 职责 |
|---|---|
| `src/index.ts` | Pi 命令、快捷键、会话生命周期、两种形态切换、实时同步 |
| `src/reader.ts` | 编码探测（UTF-8 → GB18030 回退）、段落/章节解析、中文双宽折行、翻页数学；按扩展名分发到 EPUB |
| `src/epub.ts` | 零依赖 EPUB：ZIP（stored/deflate）→ OPF spine → XHTML 提段落，章节来自 nav.xhtml / toc.ncx / 标题 |
| `src/paging.ts` | 前后翻页与位置锚定（跨宽度不跳字、读到结尾不再循环） |
| `src/search.ts` | 全文搜索：匹配偏移、上下文片段、前后循环、5 条窗口（纯函数） |
| `src/search-view.ts` | 悬浮窗组件：书架 + 搜索 |
| `src/reader-view.ts` | 多行阅读模式组件 |
| `src/widget.ts` | 常驻单行组件（固定 1 行） |
| `src/state.ts` | 书库/进度/配置的合并写入（跨实例锁、原子替换、文件监听） |
| `src/library.ts` | 路径 → 书单（`.txt` / `.epub`，支持文件夹、`~`、引号） |
| `src/manual.ts` | 把 TUTORIAL.md 生成成可读的《手册》电子书 |
| `src/wheel.ts` | 合并终端重放的滚轮事件 |
| `packages/opencode-fish/src/tui.tsx` | OpenCode TUI 适配层（composer slot、命令、实时同步） |

翻页以**段落 + 段内行偏移**为单位；进度额外记段内字符偏移，所以常驻行（72 列）和阅读模式（终端宽 - 6）之间切换、或者换窗口大小，都不会跳字。

## 开发

Pi 测试（Node 24 直接跑 TypeScript，无需构建）：

```bash
npm test
node test/preview.ts ..\剑来.txt 80 6   # 不开 Pi 预览阅读模式渲染
```

OpenCode 插件类型检查：

```bash
cd packages/opencode-fish
npm install
npm run typecheck
```

改完 Pi 源码后在 Pi 里 `/reload`；改完 OpenCode 插件后重开 TUI。

## 分发与后续路线

现在的代码已经接近可发布：

- **Pi**：`package.json` 里有 `pi.extensions`、`pi-package` keyword、`files`、peer 依赖，可直接 `npm publish`；
- **OpenCode**：`packages/opencode-fish` 有 `exports["./tui"]`，可作为 TUI-only 包加入 `cli.json`。

发布前要做的：

1. 抽 `packages/core`（reader / epub / paging / search / state / library），两个适配层都依赖它；
2. 把 Pi 包迁到 `packages/pi-fish`，做完整 npm workspaces + changesets + CI；
3. 之后可以加更多 CLI 适配层；没有常驻 UI 的 CLI 用“独立 `fish` TUI + 命令壳/状态栏”兜底；
4. 跨设备同步（可选）：云盘同步 state 文件，或自建服务（内容指纹 + 鉴权 + 离线队列）。

跨设备同步**目前没做**：现在只保证同一台机器上的多个 Pi / OpenCode 会话实时一致。

## 卸载与数据

Pi：

```bash
pi remove ./pi-fish
rm -r ~/.pi/agent/fish      # 连书库和进度一起删
```

OpenCode：从 `cli.json` 的 `plugins` 里删掉 `packages/opencode-fish` 即可；进度文件共用，删不删看你还用不用 Pi 版。

## 限制

- 支持 `.txt`（UTF-8 / GB18030 自动识别）、`.epub`（EPUB 2/3，无 DRM）和 `.md`（当纯文本读）；
- EPUB 里的图片、表格样式不保留，只取文字；`<pre>` 里的换行会被合并；
- 加密/DRM 的 EPUB、ZIP64 打包的 EPUB 会报错跳过；
- 自己加的 `.md` 按纯文本显示，`#`、`**` 会原样露出（只有内置《手册》是生成时清洗过的）；
- 常驻行一次只显示一行，读起来偏慢；要快就进阅读模式；
- 搜索悬浮窗固定只列 5 条，再往后靠 `alt+n`（阅读模式里 `n`/`N`）；
- Pi 版依赖 Pi 1.x 扩展 API（`setWidget` / `custom` / `registerShortcut` / `registerCommand`），大版本升级后建议回归一次。

## License

MIT
