# Token 优化方案 v2（Phase 1 + 2 已实施）

> 状态：Phase 1 + 2 已实施（2026-11-05）；Phase 3 未实施
> 日期：2026-11-02
> 实施日期：2026-11-05
> 范围：`artcraft-command-bridge` MCP server
> 前置：注册表本地缓存已完成（commit `3e4848c`）；`artcraft` 路由 skill 已完成（commit `f3383d8`）

## 1. 问题

注册表缓存只解决 CLI 启动开销，**不解决返回内容的 token**。当前最容易烧上下文的是：

- `artcraft_commands` 默认返回 60 条命令的完整 `params`
- `artcraft_run` 多步执行时同时返回 `results` 和原始 `stdout`
- `artcraft_run` / `artcraft_cli` 把 base64 图片当文本返回
- MCP `content` 使用 `JSON.stringify(result, null, 2)` 美化

实测基线（本机，compact JSON，按 4 字符 ≈ 1 token 粗算）：

| 调用 | 体积 | 约 token |
|---|---:|---:|
| `artcraft_commands(pdfcraft, limit=60)` | 61.5 KB | ~15k |
| `artcraft_commands(vectorcraft, limit=60)` | 43.2 KB | ~11k |
| `artcraft_commands(photocraft, limit=60)` | 18.7 KB | ~4.7k |
| `artcraft_commands(figcraft, limit=60)` | 10.7 KB | ~2.7k |
| `artcraft_apps` | 2.9 KB | ~0.7k |
| `artcraft_help(figcraft)` | 1.7 KB | ~0.4k |
| DeckCraft `file.render --print` 空白页 | 15.2 KB | ~4k |

这些结果还会留在会话历史里，实际成本要乘后续轮次。

## 2. 目标

把成本从：

```
O(app 的命令表大小)
```

变成：

```
O(本次实际用到的命令数 + 真实产物 + 一张受控预览图)
```

原则：

- 视觉任务：**看图，用 image block**
- 非视觉任务：不看图，只给元数据
- 永远不把 base64 当文本塞进上下文
- 精确查询保持现有调用次数，不额外增加 describe
- 保留 5 个工具的定位

非目标：

- 常驻 CLI 进程（只省时间，不省 token）
- 跨 app 搜索（P2）
- 模糊/自然语言搜索（P2）
- 重写注册表缓存

## 3. `artcraft_commands`：list / describe 双模式

```jsonc
{
  "app": "pdfcraft",
  "filter": "batch",       // list 模式
  "ids": ["doc_batch"],    // describe 模式，最多 8 个
  "limit": 20,             // 默认 20，最大 200
  "detail": "auto"         // auto | none | full
}
```

行为：

| 输入 | 返回 |
|---|---|
| `filter` + `auto`，命中 ≤3 条 | 直接给完整 `params`，精确查询不变差 |
| `filter` + `auto`，命中 >3 条 | 只给 `{id, label}` + 提示用 `ids` |
| `detail:"none"` | 只给 `{id, label}` |
| `detail:"full"` | 当前行为，完整 `params` |
| `ids:[...]` | 只返回这些命令的完整参数 |

List 返回示例：

```json
{
  "app": "pdfcraft",
  "detail": "list",
  "matched": 12,
  "commands": [
    { "id": "doc_batch", "label": null },
    { "id": "doc_open", "label": "command: file.open" }
  ],
  "hint": "12 matches; pass ids:[...] to get params for the commands you will run."
}
```

### 3.1 本地排序（P1）

当前 `filter` 命中后按注册表顺序截断，最佳结果可能被挤出前 20。增加评分：

```
exact id             1000
id startsWith         900
id includes           800
label startsWith      700
label includes        600
description includes  500
```

多词查询要求所有词都出现，按最高分排序。

## 4. `artcraft_run`：输出保护 + 预览

新参数：

```jsonc
{
  "preview": "auto",          // auto | none | image
  "preview_max_images": 1,
  "include_stdout": false,
  "max_output_chars": 20000,
  "max_string_chars": 4096
}
```

改动：

1. **去掉 stdout 重复**
   - 有 `results` 就不返回原始 `stdout`
   - 除非 `include_stdout: true`

2. **截断 stdout/stderr**
   - 超过 `max_output_chars` 时返回前 20k
   - 全量写入临时文件
   - 返回 `stdout_truncated` / `stdout_file` / `stdout_chars`

3. **base64 保护**
   - 结果中长度 >4096 的纯 base64 或图片字段（`png`、`jpeg`、`dataBase64` 等）替换为：

```json
{ "omitted": true, "chars": 15248, "type": "image/png" }
```

4. **视觉任务附 1 张预览图**
   - `preview:"auto"`：检测到图片结果或输出文件是图片 → 附 image block
   - `preview:"none"`：不附图
   - `preview:"image"`：强制附图

## 5. `artcraft_cli`：输出保护 + 预览文件

```jsonc
{
  "app": "figcraft",
  "args": ["export", "hero.figcraft", "-o", "hero.png", "--format", "png"],
  "preview": "auto",
  "preview_file": "D:/out/hero.png",  // 可选；不传则从 --out/-o 推断
  "max_output_chars": 20000
}
```

- stdout 超限：截断 + 全量写文件
- 有 `preview_file` 或 `--out` 图片：读取文件并附 image block
- 文件校验：
  - 只接受 png/jpeg/webp/gif
  - 检查 magic bytes
  - 单文件 ≤ 20 MB
  - 超过 4096px 提示用 app 的 `scale` 生成小图

## 6. MCP 返回结构

视觉任务：

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"app\":\"deckcraft\",\"exit_code\":0,\"output\":\"D:/out/slide.png\",\"width\":960,\"height\":540,\"bytes\":15248}"
    },
    {
      "type": "image",
      "data": "<base64>",
      "mimeType": "image/png"
    }
  ],
  "structuredContent": {
    "app": "deckcraft",
    "exit_code": 0,
    "output": "D:/out/slide.png",
    "width": 960,
    "height": 540,
    "bytes": 15248
  }
}
```

非视觉任务：

```json
{
  "content": [
    { "type": "text", "text": "{\"app\":\"wordcraft\",\"exit_code\":0,\"output\":\"D:/out/report.docx\"}" }
  ],
  "structuredContent": { "...": "..." }
}
```

红线：

- `text` 里没有 base64
- `structuredContent` 里没有 base64
- 每次最多 1 张图
- 图片只用于“看”，不作为文本保存

### 6.1 关于“图片不保存到上下文”

- **不作为文本保存**：可以做到，base64 不进 `text` / `structuredContent`
- **是否作为图片留在会话历史**：由客户端决定，MCP 没有标准的“一次性图片”标志

控制手段：

- 一次只回 1 张
- 预览控制在 960×540 或最长边 ≤1024px
- 不重复回传同一张
- 需要重看时再 `read` 文件

## 7. MCP content 压缩

当前：

```js
content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
```

改为：

```js
content: [{ type: 'text', text: JSON.stringify(result) }]
```

省 6–30% 空白。`structuredContent` 保留。

## 8. Skill 更新

`skills/artcraft/SKILL.md` 增加：

1. **视觉交付必须先看图再报完成**
   - 渲染/导出图片后，检查返回的 image block
   - 没有 image block 就 `read` 输出路径
   - 判断排版、颜色、截断、留白

2. **一次修改只看一次**
   - 同一版本不要反复读同一张图

3. **非视觉任务不看图**
   - docx/xlsx/音频/视频只查元数据

4. **命令发现纪律**
   - 必须带 `filter`
   - `limit` 5–10
   - 需要参数时用 `ids`，不要拉全量

## 9. 预期收益（估算）

### 单次调用

| 调用 | 现在 | v2 | 降幅 |
|---|---:|---:|---:|
| PdfCraft 60 条完整 | 61.5 KB (~15k) | list 20 ~1.5 KB + describe 1 条 ~2 KB ≈ 3.5 KB | ~94% |
| VectorCraft 60 条完整 | 43.2 KB (~11k) | 1.5 KB + 6.3 KB ≈ 7.8 KB | ~82% |
| FigCraft 精确 filter | 0.8 KB | 0.8 KB | 0% |
| 一次 render（base64 文本） | 15–200 KB (~4–50k) | 1 张 image block（1–3k）+ 0.5 KB 文本 | ~80–95% |
| 多步 run | results + stdout | results only | ~50% |
| MCP content | pretty JSON | compact JSON | 6–30% |

### 按任务

| 场景 | 现在 | v2 | 降幅 |
|---|---:|---:|---:|
| PdfCraft 宽查询 + 1 条命令 | ~18k | ~4k | ~78% |
| VectorCraft 宽查询 + 1 条命令 | ~13k | ~5k | ~60% |
| DeckCraft 渲染 + 看图验收 | ~25k | ~3k（图 1–3k + 摘要） | ~88% |
| FigCraft 精确创建 + 导出 | ~3k | ~2.3k | ~23% |
| 5 个混合任务 | ~80–100k | ~20–30k | ~70–75% |

### 看图成本

| 方式 | 模型看到图 | 成本 |
|---|---|---:|
| 只给路径 | ❌ | ~20 token |
| image block | ✅ | 1–3k token |
| base64 文本 | ❌ | 4–50k token |

看图不是免费，但比 base64 便宜 5–20x，而且模型真的能判断质量。

## 10. 兼容性与风险

| 风险 | 处理 |
|---|---|
| 客户端不支持 image block | 仍返回 text + 路径；skill 用 `read` 回退 |
| 图片太大导致图像 token 高 | 用 app 的 `scale`/`width` 生成小图；最长边 ≤1024px |
| 模型每步都看图 | skill 规定“一次修改看一次”；每次最多 1 张 |
| base64 检测误判 | 只处理长字符串 + 图片 key/前缀 |
| 读取任意文件 | 只接受图片扩展名 + magic bytes + 大小上限 |
| `detail:"auto"` 省略参数后模型不会用 `ids` | list 返回 `hint`；skill 明确流程；`detail:"full"` 保底 |
| 默认 limit 60→20 | 显式传 `limit:60` 仍可用 |

## 11. 实施顺序

### Phase 1（P0，4–6h）

- `artcraft_commands`：`detail` / `ids` / limit 20
- filter 排序
- MCP content compact
- skill/README

### Phase 2（P0，6–8h）

- `artcraft_run`：去 stdout 重复、截断、base64 保护
- `artcraft_cli`：截断 + 全量写文件
- `preview:"auto"` + image block
- `preview_file` 文件读取与校验
- skill 的“视觉交付必须看图”

### Phase 3（P1，4–6h）

- VectorCraft 超长参数摘要化
- 预览降采样（用 app scale）
- 跨 app 搜索（P2）

## 12. 验收指标

- 视觉任务：恰好 1 张 image block
- `text` / `structuredContent` 中没有 base64
- 图片最长边 ≤1024px（或 app 原生小尺寸）
- 非视觉任务：不返回图片
- PdfCraft list 20 条 < 2 KB
- describe 单条 < 8 KB
- render 任务总上下文 < 5k token
- 精确 filter 路径调用次数不增加
- `agg-test` / `registry-cache-test` / `token-size-test` 全过

## 13. 何时值得做

- **经常用**：做 Phase 1 + 2，约 1.5–2 天，拿到 70–90% 节省，且视觉任务能真正验收。
- **偶尔用**：不改代码，按“窄查询 + 渲染写文件 + `read` 看图”的协议。
- **只做一半**：命令发现痛 → Phase 1；render/base64 痛 → Phase 2。
- **不建议现在做**：跨 app 搜索、模糊搜索、常驻进程。

分发和发布是另一个问题：如果目标是让外部用户用起来，优先解决安装入口、demo 和目录投放，再回来做 token 优化。

## 14. 临时使用协议（不改代码）

在方案落地前，按这个用：

- `artcraft_commands` 必须带 `filter`
- `limit` 5–10
- 只查准备执行的那条命令
- 多步合并成一次 `artcraft_run`
- 导出/渲染一律 `--out` 写文件
- 视觉验收时 `read` 输出文件；不要读 base64
- 一个任务超过 3 次 ArtCraft 调用就停下来重新想

## 15. 实施记录（2026-11-05）

Phase 1 + 2 已落地：

- `artcraft_commands`：`detail`（auto/none/full）、`ids` describe 模式（最多 8 个）、默认 `limit:20`、本地评分排序。
- MCP `content`：紧凑 JSON；`structuredContent` 保留。
- `artcraft_run`：有 `results` 时默认不返回 `stdout`；`include_stdout` 可选；stdout/stderr 截断并写临时文件；base64 替换为 omitted 描述。
- `artcraft_run` / `artcraft_cli`：`preview`（auto/none/image）、最多 1 张 MCP image block、图片校验与尺寸提示；`artcraft_cli` 支持 `preview_file` 和 `-o`/`--out`/`--export` 推断。
- 新增 `tools/token-size-test.js`；`npm test` 现在同时跑聚合测试和 token 测试。
- `skills/artcraft/SKILL.md` 与中英文 README 已同步新的使用纪律。

未实施（Phase 3，P1/P2）：

- VectorCraft 超长参数摘要化。
- 预览降采样（当前只提示超过 4096px；不内置图像缩放）。
- 跨 app 搜索、模糊搜索、常驻进程（仍按原计划不做）。
