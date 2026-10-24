# artcraft-command-bridge

**一个 MCP 服务器管住 13 个 [ArtCraft Crafting Apps](https://getartcraft.com/apps) —— 5 个工具顶替 799 个。**

每个 Crafting App 都自带 MCP 服务器，把每一条引擎命令都摊成独立工具。13 个全注册 =
**799 个工具 / 547 KB schema ≈ 14 万 token 常驻上下文**，而且这份载荷**每轮请求都要重发一遍**。

这个桥接器改为直接驱动各 app 的 CLI，只暴露 **5 个工具 / 3.5 KB**。

```
799 工具 · 547.3 KB · ~140,000 token   →   5 工具 · 3.5 KB · ~900 token
```

---

## 为什么需要它

MCP 客户端会把一个服务器的工具清单**全量注册**。协议里没有"先只给名字、调用时再取 schema"这种模式 —— client 调一次 `tools/list`，就把每个工具的 `name` + `description` + `inputSchema` 永久留在系统载荷里。部分客户端有按需检索工具的机制，但那只覆盖 deferred 工具（定时任务、integrations），**不覆盖 MCP 服务器的工具**。

Crafting Apps 本身已经有一套非常适合做这件事的模型：

- `commands` —— 列出稳定命令 ID 及其参数
- `run` —— 按 ID 执行

13 个 app 实测共 **7027 条命令 ID**。而原厂 MCP 暴露的 799 个工具，只是同一份注册表的一个子集视图。所以这些工具不需要被摊平成 799 条并列项 —— 它们需要的是一份**目录**和一个**分发器**，这就是这个桥接器。

只有 PdfCraft 自带一个接近按需的模式（`pdfcraft-cli mcp --compact`，只暴露核心工具 + `tool_search`/`tool_call`）；另外 12 个直接拒绝 `--compact`，所以没有统一开关可开。

## 快速开始

1. 装你需要的 app —— 见 [getartcraft.com/apps](https://getartcraft.com/apps)。每个 app 会装一个 `<app>-cli` 可执行文件。

2. 把这个服务器注册进你的 MCP 客户端：

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

   或者用官方安装方式：

   ```sh
   npm install -g artcraft-command-bridge
   ```

3. 重启客户端让工具加载。

## 5 个工具

| 工具 | 作用 |
|---|---|
| `artcraft_apps` | 13 个 app 的用途、版本、安装状态、run 参数风格。从这里开始。 |
| `artcraft_commands` | 某 app 的稳定命令 ID + 参数说明，支持子串过滤。 |
| `artcraft_run` | 按 ID 顺序执行一条或多条命令。确定性干活的路子。 |
| `artcraft_cli` | 逃生舱 —— 透传任意子命令（`export`/`render`/`convert`/`info`/`batch`）。 |
| `artcraft_help` | 某 app 自己的 `--help` 全文。 |

### 用法示例

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
```

## 工作原理

各 app 的 `run` 参数形态不一样，桥接器把统一的 `{ id, params }` 翻译成各家自己的语法：

| 参数风格 | app |
|---|---|
| `--cmd <id> --params <json>` | PhotoCraft、VectorCraft |
| `--cmd <id>={<json>}` | DesignCraft、GridCraft、SoundCraft、DeckCraft、WordCraft |
| `--cmd '<id> <json>'` | CADCraft |
| 位置参数 `<id> <json>` | LightCraft、EffectCraft |
| script 文件 `run <script.json>` | FigCraft（`{command, params}`） |
| script 文件 `run <script.jsonl>` | FilmCraft（`{id, params}`） |
| `run <tool> key=value` | PdfCraft（用 tool 名，不是命令 ID） |

命令注册表的暴露方式也不一样，同样做了归一化：

| 注册表形态 | app |
|---|---|
| `commands --json` | PhotoCraft、VectorCraft、FigCraft、GridCraft、LightCraft、EffectCraft、FilmCraft、WordCraft |
| `commands`（纯 JSON） | CADCraft、DesignCraft —— 它们的 `--json` 会被当过滤词，返回 `[]` |
| 纯文本表 | DeckCraft、SoundCraft |
| `tools` 子命令 | PdfCraft 根本没有 `commands` |

## 怎么找到 CLI

`artcraft_apps` 会报告探测结果。桥接器按顺序找：

1. `ARTCRAFT_<APP>_CLI` —— 例如 `ARTCRAFT_PHOTOCRAFT_CLI=/opt/craft/photocraft-cli`
2. `ARTCRAFT_HOME` 与官方各系统 app 根目录
   （`%LOCALAPPDATA%\storytold\apps`、`~/.local/share/storytold/apps`、
   `~/Library/Application Support/storytold/apps`）
3. `PATH` 里的 `<app>-cli`
4. 系统安装位置
   （`C:\Program Files\<App>Craft\`、`/Applications/<App>Craft.app/Contents/MacOS/`、
   `/usr/local/bin`）

没装的 app 会被标成未安装并跳过 —— 少装一个不会让整个桥接器挂掉。

## 和现有方案的差别

- **[eznix86/mcp-gateway](https://github.com/eznix86/mcp-gateway)**（MIT）—— 思路一样的通用网关，但它聚合的是 **MCP 服务器层**，那 13 个 Crafting App 服务器还是得作为上游进程常驻，而且它的 `search` 是文本相似度，不是注册表精确查。
- **[ai-2070/claude-storytold-skills](https://github.com/ai-2070/claude-storytold-skills)**（MIT）—— Claude Code 插件，每个 app 一个 skill，用 grep 查生成的命令目录。同一目标，不同层次：它照样用 `claude mcp add` 把每个 app 的 MCP server 注册进去，schema 依然常驻。
- **[smyrgeorge/artcraft-toolbox](https://github.com/smyrgeorge/artcraft-toolbox)**（Apache-2.0）—— 套件**管理器**（安装、校验、更新、启动）。两者互补：toolbox 负责把 app 弄到机器上，这个桥接器负责让它们好用。

## 开发

```sh
node tools/probe-mcp.js           # 探测每个 app 的 MCP 握手 + 工具数
node tools/schema-size.js         # 量 schema 体量，刷新 registry 快照
node tools/agg-test.js            # 桥接器端到端自测
node tools/per-app-verify.js      # 验证各 app 的 run 参数是否被引擎接受
node tools/cursor-launch-check.js # 按客户端的方式启动桥接器
```

运行时零依赖；Node ≥ 18。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。商标声明见 [NOTICE](NOTICE)。
Crafting Apps 本身是开源的（MIT OR Apache-2.0），开发于
[github.com/storytold](https://github.com/storytold)。
