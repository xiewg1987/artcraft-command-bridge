# artcraft-command-bridge

[English](README.md) · [简体中文](README.zh-CN.md)

**一个 MCP 服务器管住 15 个 [ArtCraft Crafting Apps](https://getartcraft.com/apps) —— 5 个工具顶替 866 个。**

`artcraft-command-bridge` 是一个驱动本机 ArtCraft CLI 的 MCP 服务器。它是**桥接器**，不是安装器或更新器：用 ArtCraft Launcher（或各 App 的独立安装包）安装和更新 App，然后让这个服务器通过 5 个工具把它们交给你的 agent。

每个 Crafting App 都自带 MCP 服务器，把每条引擎命令摊成独立工具。15 个全装 = **866 个工具 / 630.6 KB schema ≈ 16.1 万 token** 常驻上下文，而且每轮请求都要重发一遍。这个桥接器把同一份命令注册表收进一个**目录**和一个**分发器**：

```text
866 工具 · 630.6 KB · ~161,000 token   →   5 工具 · 3.7 KB · ~950 token
```

2026-11-05 在 Windows 上装齐 15 个 App 后实测。

---

## 为什么需要它

MCP 客户端会把一个服务器的工具清单**全量注册**。协议里没有“先只给名字、调用时再取 schema”这种模式 —— client 调一次 `tools/list`，就把每个工具的 `name` + `description` + `inputSchema` 永久留在系统载荷里。部分客户端有按需检索工具的机制，但那只覆盖 deferred 工具（定时任务、integrations），**不覆盖 MCP 服务器的工具**。

Crafting Apps 本身已经有一套非常适合做这件事的模型：

- `commands` —— 列出稳定命令 ID 及其参数
- `run` / `batch` —— 按 ID 执行

15 个 App 实测共 **7606 条命令 ID**。而原厂 MCP 暴露的 866 个工具，只是同一份注册表的一个子集视图。所以这些工具不需要被摊平成 866 条并列项 —— 它们需要的是一份**目录**和一个**分发器**，这就是这个桥接器。

只有 PdfCraft 自带一个接近按需的模式（`pdfcraft-cli mcp --compact`，只暴露核心工具 + `tool_search`/`tool_call`）；另外 14 个没有等价的 `--compact` 模式，所以没有统一开关可开。

## 快速开始

### 1. 安装 App

按需安装 —— 见 [getartcraft.com/apps](https://getartcraft.com/apps)。推荐用 ArtCraft Launcher，它会安装全部 App 并保持更新。每个 App 会装一个 `<app>-cli` 可执行文件。

桥接器本身不安装、不更新 App。App 升级只会让对应注册表缓存失效，不会修改桥接器代码。

### 2. 注册 MCP 服务器

OpenCode（`~/.config/opencode/opencode.json`）：

```jsonc
{
  "mcp": {
    "servers": {
      "artcraft-command-bridge": {
        "type": "local",
        "command": ["node", "D:/path/to/artcraft-command-bridge/server.js"],
        "enabled": true
      }
    }
  }
}
```

其他 MCP 客户端（`mcpServers`）：

```jsonc
{
  "mcpServers": {
    "artcraft-command-bridge": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/artcraft-command-bridge/server.js"]
    }
  }
}
```

或者全局安装：

```sh
npm install -g artcraft-command-bridge
```

### 3. 重启并确认

重启客户端让工具加载。然后调用 `artcraft_apps`：它会列出全部 15 个 App，`installed_count` 表示本机实际安装了几个。

## 5 个工具

| 工具 | 作用 |
|---|---|
| `artcraft_apps` | 15 个 App 的用途、版本、安装状态、run 参数风格。从这里开始。 |
| `artcraft_commands` | 某 App 的稳定命令 ID + 参数说明，从本地缓存读取，支持子串过滤。 |
| `artcraft_run` | 按 ID 顺序执行一条或多条命令。确定性干活的路子。 |
| `artcraft_cli` | 逃生舱 —— 透传任意子命令（`export`/`render`/`convert`/`info`/`batch`）。 |
| `artcraft_help` | 某 App 自己的 `--help` 全文。 |

## 15 个 App

| App | 适合做什么 | `run` 风格 | 注册表 |
|---|---|---|---|
| **PhotoCraft** (`photocraft`) | 像素编辑、图层、蒙版、PSD | `cmd-params` | `commands --json` |
| **LightCraft** (`lightcraft`) | RAW 显影、选片、批量变体 | `positional` | `commands --json` |
| **VectorCraft** (`vectorcraft`) | Logo、图标、路径、印刷矢量 | `cmd-params` | `commands --json` |
| **DesignCraft** (`designcraft`) | 多页印刷、主页、PDF/X | `cmd-inline-eq` | `commands`（JSON） |
| **GridCraft** (`gridcraft`) | 表格、公式、图表 | `cmd-inline-eq` | `commands --json` |
| **SoundCraft** (`soundcraft`) | 音频剪辑、播客、混音/母带 | `cmd-inline-eq` | `commands`（文本表） |
| **DeckCraft** (`deckcraft`) | 幻灯片、pptx | `cmd-inline-eq` | `commands`（文本表） |
| **WordCraft** (`wordcraft`) | 长文档、报告、docx | `cmd-inline-eq` | `commands --json` |
| **CADCraft** (`cadcraft`) | CAD 制图、尺寸、DXF/DWG | `cmd-inline-sp` | `commands`（JSON） |
| **EffectCraft** (`effectcraft`) | 动态图形、关键帧、合成 | `positional` | `commands --json` |
| **FilmCraft** (`filmcraft`) | 视频时间线、剪辑、字幕、MP4 | `script-jsonl` | `commands --json` |
| **FigCraft** (`figcraft`) | UI 界面、组件、原型 | `script-json` | `commands --json` |
| **TextureCraft** (`texturecraft`) | 3D 贴图集、绘制、烘焙 | `batch-json` | `commands`（文本表） |
| **MaterialCraft** (`materialcraft`) | 程序化 PBR 材质、节点图 | `batch-json` | `commands`（JSON） |
| **PdfCraft** (`pdfcraft`) | PDF 合并/拆分、表单、OCR、脱敏 | `positional-kv` | `tools` |

风格速查：

```text
cmd-params      --cmd <id> --params <json>        PhotoCraft, VectorCraft
cmd-inline-eq   --cmd <id>={<json>}               DesignCraft, GridCraft, SoundCraft,
                                                   DeckCraft, WordCraft
cmd-inline-sp   --cmd '<id> <json>'                CADCraft
positional      <id> <json>                       LightCraft, EffectCraft
script-json     run <script.json>                 FigCraft ({command, params})
script-jsonl    run <script.jsonl>                FilmCraft ({id, params})
batch-json      batch <script.json>               TextureCraft, MaterialCraft
                                                   ({open, steps, save})
positional-kv   run <tool> key=value              PdfCraft（tool 名，不是命令 ID）
```

注册表说明：

- `commands --json` 是首选形态。
- CADCraft/DesignCraft 会把 `--json` 当过滤词并返回 `[]`；MaterialCraft 把 `--json` 当未知选项。桥接器会回退到纯 `commands`。
- DeckCraft/SoundCraft/TextureCraft 输出纯文本表。
- PdfCraft 没有 `commands`；桥接器把它的 `tools` 列表归一化成同样的形状。

## 用法示例

```jsonc
// figcraft 有哪些命令？
{ "app": "figcraft", "filter": "node.create" }

// 建一个画板
{
  "app": "figcraft",
  "steps": [
    { "id": "node.create", "params": { "type": "frame", "name": "Hero", "width": 1200, "height": 800 } }
  ],
  "output": "D:/out/hero.figcraft"
}

// 导出（不是命令 ID —— 走逃生舱）
{ "app": "figcraft", "args": ["export", "hero.figcraft", "-o", "hero.png", "--format", "png", "--node", "Hero"] }

// 画一层贴图并保存原生工程（batch-json 风格）
{
  "app": "texturecraft",
  "steps": [
    { "id": "layer.add.fill", "params": { "name": "Base", "color": "#c94f3d" } }
  ],
  "output": "D:/out/armor.tcraft"
}

// 生成一个程序化材质包（batch-json 风格）
{
  "app": "materialcraft",
  "steps": [
    { "id": "graph.seed", "params": { "seed": 7 } }
  ],
  "output": "D:/out/brick.sbs"
}
```

## 注册表缓存与更新

`artcraft_commands` 不再每次调用都启动 CLI。每个 App 第一次读取时拉一次注册表并写到本机缓存，之后直接从磁盘读。缓存 key 是 CLI 的**路径 + mtime + size**，App 升级后会自动失效。

```sh
artcraft-sync-registry                 # 全局安装后的命令
node tools/sync-registry.js            # 或在仓库里运行
node tools/sync-registry.js --check    # 只补缺失/过期的
node tools/sync-registry.js --app figcraft pdfcraft
node tools/sync-registry.js --clear    # 清空缓存
```

单个 App 需要强制重读时，给 `artcraft_commands` 传 `refresh: true`。缓存目录可用 `ARTCRAFT_CACHE_DIR` 覆盖；默认位置：Windows `%LOCALAPPDATA%\artcraft-command-bridge\registry`，macOS `~/Library/Caches/artcraft-command-bridge/registry`，Linux `$XDG_CACHE_HOME/artcraft-command-bridge/registry`（或 `~/.cache/...`）。

缓存命中省掉的是 CLI 进程，不会缩小返回内容：token 消耗取决于返回的命令列表，而不是它从哪里读出来。用 `filter` 和 `limit` 控制列表大小。

### 安装或更新 App 之后

注册表缓存会自动处理 CLI 的变化。但 App **目录**是在桥接器启动时加载的，所以新增或移除 App 后要重启 MCP 客户端。然后调用 `artcraft_apps`：它会列出全部 15 个条目，`installed_count` 表示本机实际安装了几个。如果仍看到旧列表，检查客户端启动的是哪个 `server.js` —— 进程命令行应该指向当前这份 checkout，而不是旧副本。

## 怎么找到 CLI

`artcraft_apps` 会报告探测结果。桥接器按顺序找：

1. `ARTCRAFT_<APP>_CLI` —— 例如 `ARTCRAFT_PHOTOCRAFT_CLI=/opt/craft/photocraft-cli`
2. `ARTCRAFT_HOME` 与官方各系统 App 根目录
   （`%LOCALAPPDATA%\storytold\apps`、`~/.local/share/storytold/apps`、
   `~/Library/Application Support/storytold/apps`）
3. `PATH` 里的 `<app>-cli`
4. 系统安装位置
   （`C:\Program Files\<App>Craft\`、`/Applications/<App>Craft.app/Contents/MacOS/`、
   `/usr/local/bin`）

没装的 App 会被标成未安装并跳过 —— 少装一个不会让整个桥接器挂掉。

## 范围与限制

- **15 个由命令驱动的 Crafting App。** Craft Anything 是一个带自有工具协议的 agent 前端，不是 `commands` + `run`/`batch` 引擎，所以桥接器不包装它。
- **桥接器不安装、不更新、不启动 GUI App。** 这些交给 ArtCraft Launcher 或各 App 的安装包。
- **`input`/`output` 支持情况不同：**
  - 两者都支持：PhotoCraft、VectorCraft、SoundCraft、FilmCraft、FigCraft、TextureCraft、MaterialCraft
  - 只支持 input：DesignCraft、GridCraft、DeckCraft、WordCraft、CADCraft
  - 只支持 output：PdfCraft
  - 两者都不支持：LightCraft、EffectCraft
- **TextureCraft / MaterialCraft** 使用 batch JSON 脚本。`output` 保存原生工程（`.tcraft` / `.sbs`）；PNG/EXR 贴图导出走 `artcraft_cli export`。

## 和现有方案的差别

- **[eznix86/mcp-gateway](https://github.com/eznix86/mcp-gateway)**（MIT）—— 思路一样的通用网关，但它聚合的是 **MCP 服务器层**，那 15 个 Crafting App 服务器还是得作为上游进程常驻，而且它的 `search` 是文本相似度，不是注册表精确查。
- **[ai-2070/claude-storytold-skills](https://github.com/ai-2070/claude-storytold-skills)**（MIT）—— Claude Code 插件，每个 App 一个 skill，用 grep 查生成的命令目录。同一目标，不同层次：它照样用 `claude mcp add` 把每个 App 的 MCP server 注册进去，schema 依然常驻。
- **[smyrgeorge/artcraft-toolbox](https://github.com/smyrgeorge/artcraft-toolbox)**（Apache-2.0）—— 套件**管理器**（安装、校验、更新、启动）。两者互补：toolbox 负责把 App 弄到机器上，这个桥接器负责让它们好用。

## 开发

```sh
npm test                          # 5 工具握手 + FigCraft 冒烟测试
npm run test:registry             # 先 cache miss，再 cache hit
node tools/sync-registry.js       # 把命令注册表拉到本地缓存
node tools/probe-mcp.js           # 探测每个 App 的 MCP 握手 + 工具数
node tools/schema-size.js         # 量 schema 体量，刷新 registry 快照
node tools/agg-test.js            # 桥接器端到端自测
node tools/per-app-verify.js      # 验证各 App 的 run 参数是否被引擎接受
node tools/cursor-launch-check.js # 按客户端的方式启动桥接器
```

运行时零依赖；Node ≥ 18。

设计记录：[token 优化方案](docs/token-optimization-plan.md)（提案，未实施）。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。商标声明见 [NOTICE](NOTICE)。
Crafting Apps 本身是开源的（MIT OR Apache-2.0），开发于
[github.com/storytold](https://github.com/storytold)。
