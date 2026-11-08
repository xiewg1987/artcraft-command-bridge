# Token 优化方案 v3（已实施）

> 实施日期：2026-11-08
> 范围：`artcraft-command-bridge` 2.0
> 目标：降低每次请求的常驻 schema、命令发现结果、执行结果和图片成本，同时修正参数适配与文件安全问题。

## 1. 原先的上下文浪费点

v2 已经避免把完整注册表、原始 stdout 和 base64 默认塞进上下文，但仍有这些重复成本：

- `structuredContent` 与紧凑 text 返回同一份 JSON，默认形成双份载荷。
- `artcraft_apps` 每次都返回 15 个 app 的 purpose、版本、CLI 路径和内部 run style。
- `artcraft_commands` 列表返回对象并携带缓存路径、抓取时间等调试信息。
- 执行结果保留 `command/id/ok/status` 包装，而调用者已经知道输入 steps。
- `artcraft_cli` 即使 stdout 是 JSON，也按转义字符串返回。
- 图片默认开启，超过 4096px 仍会进入上下文。
- stdout 在截断前先完整积累到内存，大日志既有 token 风险也有进程内存风险。

## 2. 默认输出策略

| 工具 | 新默认 | 省 token 的原因 |
|---|---|---|
| `artcraft_apps` | `installed_count + installed + missing` | 不执行版本探测，不返回路径/说明 |
| `artcraft_commands` | 最多 10 个 ID 字符串 | 不返回 label 对象或缓存诊断 |
| `artcraft_run` | 紧凑 step 值 | 去掉重复命令 ID、ok/status 包装和 argv |
| `artcraft_cli` | 直接返回解析后的 JSON | 不再返回转义后的原始 JSON 字符串 |
| `artcraft_help` | 最多 6,000 字符 | 默认不拉取整段超长帮助 |
| MCP result | 只有紧凑 text；图片需显式开启 | 不再默认双份 `structuredContent` |

需要完整信息时使用：

```jsonc
// 诊断/版本
{ "detail": "full" }

// 更多候选 ID
{ "app": "figcraft", "filter": "node", "limit": 20 }

// 指定命令的完整参数；单条默认上限 2,400 字符
{ "app": "figcraft", "ids": ["node.create"], "max_param_chars": 6000 }

// 原始输出或更多结构化结果
{ "include_stdout": true, "max_output_chars": 20000, "max_result_chars": 20000 }
```

## 3. 图片策略

- `preview` 默认是 `none`。
- 视觉验收时显式使用 `preview:"auto"` 或 `preview:"image"`。
- 每次最多 1 张。
- 文件最大 4MB，长边最大 1,024px；超过时只返回 `preview_warning`，不附图片。
- 大图先通过 App 的 scale/size 参数导出缩略图。
- base64 永远不进入 text；客户端若需要结构化结果，可显式设置 `ARTCRAFT_STRUCTURED=1`。

## 4. 输出有界化

- CLI stdout/stderr 超过 256KiB 时流式写入临时文件，只在内存保留有界前缀。
- `max_output_chars` 默认 6,000，最大 50,000。
- `max_result_chars` 默认 8,000，最大 50,000；超出时返回 `results_file` / `result.file`。
- base64 与长图片字段使用 `omitted` 描述替代。
- UTF-8 使用 `StringDecoder`，避免分块边界破坏中文字符。

## 5. 参数与文件修复

- DesignCraft、GridCraft、DeckCraft、WordCraft、CADCraft 的 `output` 使用各自真实 flag。
- SoundCraft `.scraft` 使用 `--save`，音频使用 `--bounce`。
- EffectCraft 使用 `--project` / `--empty` / `--save-as`。
- FilmCraft 使用顶层 `--project` 和 `--save-as`。
- PdfCraft 的多步骤改成一个 `{tool,args}` JSON 脚本，通过 `run --script ... --report` 执行。
- 插件只清理自己创建并显式登记的临时脚本，不再按“位于 TEMP 且扩展名为 json”删除文件。
- 临时脚本名加入进程序号和随机 nonce，避免并发覆盖。

## 6. 实测结果

本机 15 个 App 全安装，按 4 chars ≈ 1 token 粗略估算：

| 项目 | v2 | v3 |
|---|---:|---:|
| 5-tool schema | ~5.2KB | ~4.8KB |
| `artcraft_apps` 默认 | ~2.9KB | 229 chars |
| PdfCraft 默认列表 | 1,238 chars / 20 条 | 275 chars / 10 个 ID |
| FigCraft 单步结果 | 带 wrapper/stdout/argv 字段 | `{"exit_code":0,"results":[{"id":2}]}` |
| PdfCraft 两步骤 | wrapper + pretty report | 1,856 chars（含 `action_list` 明细） |
| MCP 结构化载荷 | text + structuredContent | 默认仅 text |

实际节省主要来自：

- 列表从对象改 ID、缓存元信息默认关闭；
- 执行结果去掉重复包装和 argv；
- JSON CLI 输出不再以转义字符串重复；
- `structuredContent` 不再默认双份；
- 图片默认关闭并限制到 1,024px。

## 7. 验证

- `tools/adapter-contract-test.js`：逐 App 检查 argv、输入输出 flag、PdfCraft 脚本和临时文件清理。
- `tools/exec-test.js`：验证 256KiB 以上输出落盘、UTF-8 与有界内存前缀。
- `tools/token-size-test.js`：验证 schema、紧凑列表、结果包装、输出/结果上限、无默认结构化重复和图片限制。
- `tools/output-integration-test.js`：在已安装的 App 上实际检查原生/导出文件是否落盘。
- `tools/agg-test.js`：MCP 握手与基本生命周期。
- `tools/registry-cache-test.js`：注册表缓存 miss/hit。

## 8. 使用纪律

1. 命令搜索带 `filter`，`limit` 保持 5–10。
2. 只为准备执行的 1–6 条命令使用 `ids`。
3. 多步命令合并到一次 `artcraft_run`。
4. 非视觉任务不开启图片。
5. 视觉任务先导出 ≤1,024px 的预览，再显式开启 preview。
6. 只在排错时请求 raw stdout/完整结构化结果。
