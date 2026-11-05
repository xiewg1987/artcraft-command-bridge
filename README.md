# artcraft-command-bridge

[English](README.md) · [简体中文](README.zh-CN.md)

**One MCP server for the 15 [ArtCraft Crafting Apps](https://getartcraft.com/apps) — 5 tools instead of 871.**

`artcraft-command-bridge` is an MCP server that drives the installed ArtCraft
CLIs. It is a **bridge**, not an installer or updater: install and update the
apps with the ArtCraft Launcher (or their standalone installers), then let this
server expose them to your agent through five tools.

Each Crafting App ships its own MCP server that turns every engine command into
a separate tool. With all 15 apps installed that is **871 tools / 640.8 KB of
schema ≈ 164k tokens** of permanently resident context, re-sent on *every*
request. This bridge keeps the same command registries behind a directory and a
dispatcher:

```text
871 tools · 640.8 KB · ~164,000 tokens   →   5 tools · 5.2 KB · ~1,300 tokens
```

Measured on 2026-11-05 with all 15 apps installed on Windows.

---

## Why this exists

MCP clients register a server's tool list in full. The protocol has no
"just give me the names, fetch the schema on demand" mode — the client calls
`tools/list` once and keeps every tool's `name` + `description` + `inputSchema`
in the system payload forever. Some clients have an on-demand tool *search*
facility, but that covers deferred tools (cron, integrations), not MCP server
tools.

The Crafting Apps already share one model that is perfect for this:

- `commands` — lists stable command IDs with their parameters
- `run` / `batch` — executes those IDs

Measured across the 15 apps, that is **7631 command IDs**. The 871 tools the
apps' own MCP servers expose are only a subset view of the same registry. So
the tools do not need to be flattened into 871 separate entries — they need a
**directory** and a **dispatcher**, which is what this is.

Only PdfCraft ships an on-demand mode of its own (`pdfcraft-cli mcp --compact`,
which exposes a core set plus `tool_search`/`tool_call`); the other fourteen have
no equivalent `--compact` mode, so there was no unified switch to simply turn on.

## Quick start

### 1. Install the apps

Install the apps you need — see [getartcraft.com/apps](https://getartcraft.com/apps).
The recommended path is the ArtCraft Launcher, which installs every app and keeps
them updated. Each app installs a `<app>-cli` binary.

The bridge does not install or update them. Updating an app only invalidates its
registry cache; it does not change the bridge code.

### 2. Register the server

OpenCode (`~/.config/opencode/opencode.json`):

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

Other MCP clients (`mcpServers`):

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

Or install the package globally:

```sh
npm install -g artcraft-command-bridge
```

### 3. Restart and verify

Restart the client so the tools load. Then call `artcraft_apps`: it lists all
15 app entries and `installed_count` reports how many are present on this
machine.

## The 5 tools

| Tool | What it does |
|---|---|
| `artcraft_apps` | The 15 apps: purpose, version, install status, and how their `run` argv is built. Start here. |
| `artcraft_commands` | List command IDs or describe exact IDs. List mode is default; `ids` returns full params. Cached locally. |
| `artcraft_run` | Execute commands in order. Compact results, truncated output, base64 redaction, optional preview. |
| `artcraft_cli` | Escape hatch — run any CLI subcommand verbatim, with output truncation and image preview. |
| `artcraft_help` | An app's own `--help` text. |

## Token efficiency

The default path is optimized for context:

- `artcraft_commands` starts in **list mode** (default `limit:20`, only
  `{id,label}`). A filter with at most 3 matches returns full `params`; broader
  matches stay compact. Pass `ids:[...]` (max 8) to fetch full params only for
  the commands you will actually run. There is no extra describe round-trip for
  exact filters.
- `artcraft_run` omits raw `stdout` when parsed `results` exist. Set
  `include_stdout:true` to keep it. Output over `max_output_chars` (default
  20k) is truncated and the full text is written to a temp file
  (`stdout_file` / `stderr_file`).
- Long base64/image strings are replaced with
  `{ "omitted": true, "chars": 12345, "type": "image/png" }`; they never enter
  `text` or `structuredContent`.
- Visual outputs attach **at most one** MCP image block. The image is not
  duplicated as base64 in text; use `preview:"none"` for non-visual tasks.
  `artcraft_cli` infers `-o` / `--out` / `--export`, or accepts `preview_file`.
- MCP text content is compact JSON. `structuredContent` carries the same data
  without pretty-printing or image bytes.

## The 15 apps

| App | Pick it for | `run` style | Registry |
|---|---|---|---|
| **PhotoCraft** (`photocraft`) | Pixel editing, layers, masks, PSD | `cmd-params` | `commands --json` |
| **LightCraft** (`lightcraft`) | RAW development, culling, variants | `positional` | `commands --json` |
| **VectorCraft** (`vectorcraft`) | Logos, icons, paths, print vector | `cmd-params` | `commands --json` |
| **DesignCraft** (`designcraft`) | Multi-page print, master pages, PDF/X | `cmd-inline-eq` | `commands` (JSON) |
| **GridCraft** (`gridcraft`) | Spreadsheets, formulas, charts | `cmd-inline-eq` | `commands --json` |
| **SoundCraft** (`soundcraft`) | Audio editing, podcast, mix/master | `cmd-inline-eq` | `commands` (text table) |
| **DeckCraft** (`deckcraft`) | Slide decks, pptx | `cmd-inline-eq` | `commands` (text table) |
| **WordCraft** (`wordcraft`) | Long-form documents, docx | `cmd-inline-eq` | `commands --json` |
| **CADCraft** (`cadcraft`) | CAD drawings, dimensions, DXF/DWG | `cmd-inline-sp` | `commands` (JSON) |
| **EffectCraft** (`effectcraft`) | Motion graphics, keyframes, comps | `positional` | `commands --json` |
| **FilmCraft** (`filmcraft`) | Video timeline, cuts, captions, MP4 | `script-jsonl` | `commands --json` |
| **FigCraft** (`figcraft`) | UI screens, components, prototypes | `script-json` | `commands --json` |
| **TextureCraft** (`texturecraft`) | 3D texture sets, painting, baking | `batch-json` | `commands` (text table) |
| **MaterialCraft** (`materialcraft`) | Procedural PBR materials, node graphs | `batch-json` | `commands` (JSON) |
| **PdfCraft** (`pdfcraft`) | PDF merge/split, forms, OCR, redact | `positional-kv` | `tools` |

Style reference:

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
positional-kv   run <tool> key=value              PdfCraft (tool names, not IDs)
```

Registry notes:

- `commands --json` is the preferred shape.
- CADCraft/DesignCraft treat `--json` as a filter and return `[]`; MaterialCraft
  rejects it as an unknown option. The bridge falls back to plain `commands`.
- DeckCraft/SoundCraft/TextureCraft print plain-text tables.
- PdfCraft has no `commands`; the bridge normalizes its `tools` list.

## Examples

```jsonc
// list matching IDs only (broad query; keeps params out of context)
{ "app": "figcraft", "filter": "node", "limit": 10 }

// get full params for the commands you will run
{ "app": "figcraft", "ids": ["node.create"] }

// build a frame
{
  "app": "figcraft",
  "steps": [
    { "id": "node.create", "params": { "type": "frame", "name": "Hero", "width": 1200, "height": 800 } }
  ],
  "output": "D:/out/hero.figcraft"
}

// export it (not a command ID — use the escape hatch); preview attaches the PNG
{
  "app": "figcraft",
  "args": ["export", "hero.figcraft", "-o", "hero.png", "--format", "png", "--node", "Hero"],
  "preview": "auto"
}

// paint a texture set and save the native project (batch-json style)
{
  "app": "texturecraft",
  "steps": [
    { "id": "layer.add.fill", "params": { "name": "Base", "color": "#c94f3d" } }
  ],
  "output": "D:/out/armor.tcraft"
}

// build a procedural material package (batch-json style)
{
  "app": "materialcraft",
  "steps": [
    { "id": "graph.seed", "params": { "seed": 7 } }
  ],
  "output": "D:/out/brick.sbs"
}
```

## Registry cache and updates

`artcraft_commands` does not spawn the CLI on every call. The first read of an
app pulls its registry once and writes it to a per-machine cache; later reads
are served from disk. The cache key is the CLI's **path + mtime + size**, so
updating an app invalidates its entry automatically.

```sh
artcraft-sync-registry                 # installed global CLI
node tools/sync-registry.js            # or from a checkout
node tools/sync-registry.js --check    # only fill missing/stale entries
node tools/sync-registry.js --app figcraft pdfcraft
node tools/sync-registry.js --clear    # delete the cache
```

Pass `refresh: true` to `artcraft_commands` to re-read one app. Override the
location with `ARTCRAFT_CACHE_DIR`; the default is
`%LOCALAPPDATA%\artcraft-command-bridge\registry` on Windows,
`~/Library/Caches/artcraft-command-bridge/registry` on macOS, and
`$XDG_CACHE_HOME/artcraft-command-bridge/registry` (or `~/.cache/...`) on Linux.

A cache hit removes the CLI process from discovery, but it does not shrink the
response: the token cost is the returned command list, not where it was read
from. Use `filter` and `limit` to keep that list small.

### After installing or updating an app

The registry cache handles CLI changes automatically. The app **catalog** is
loaded when the bridge starts, so restart the MCP client after adding or
removing an app. Then call `artcraft_apps`: it lists all 15 entries and
`installed_count` reports how many are present. If an old list persists, check
which `server.js` the client launches — the process command line should point
at this checkout, not an old copy.

## Finding the CLIs

`artcraft_apps` reports what it found. The bridge probes, in order:

1. `ARTCRAFT_<APP>_CLI` — e.g. `ARTCRAFT_PHOTOCRAFT_CLI=/opt/craft/photocraft-cli`
2. `ARTCRAFT_HOME` and the official per-OS app roots
   (`%LOCALAPPDATA%\storytold\apps`, `~/.local/share/storytold/apps`,
   `~/Library/Application Support/storytold/apps`)
3. `PATH` (`<app>-cli`)
4. System install locations
   (`C:\Program Files\<App>Craft\`, `/Applications/<App>Craft.app/Contents/MacOS/`,
   `/usr/local/bin`)

Apps that are not installed are reported as such and skipped — the bridge never
fails as a whole because one app is missing.

## Scope and limitations

- **15 command-driven Crafting Apps.** Craft Anything is an agent front-end with
  its own tool protocol, not a `commands` + `run`/`batch` engine, so the bridge
  does not wrap it.
- **The bridge does not install, update, or launch GUI apps.** Use the ArtCraft
  Launcher or the apps' installers for that.
- **`input`/`output` support varies:**
  - both: PhotoCraft, VectorCraft, SoundCraft, FilmCraft, FigCraft, TextureCraft,
    MaterialCraft
  - input only: DesignCraft, GridCraft, DeckCraft, WordCraft, CADCraft
  - output only: PdfCraft
  - neither: LightCraft, EffectCraft
- **TextureCraft / MaterialCraft** use a batch JSON script. `output` saves the
  native project (`.tcraft` / `.sbs`); export PNG/EXR maps with
  `artcraft_cli export`.

## Why not an existing tool?

- **[eznix86/mcp-gateway](https://github.com/eznix86/mcp-gateway)** (MIT) — a
  general-purpose gateway with the same idea, but it aggregates *MCP servers*,
  so the 15 Crafting App servers still have to be running as upstream
  processes, and its `search` is text-similarity rather than an exact registry
  lookup.
- **[ai-2070/claude-storytold-skills](https://github.com/ai-2070/claude-storytold-skills)**
  (MIT) — a Claude Code plugin whose per-app skills use grep over generated
  reference catalogs. Same goal, different layer: it still registers every
  app's MCP server with `claude mcp add`, so the tool schemas stay resident.
- **[smyrgeorge/artcraft-toolbox](https://github.com/smyrgeorge/artcraft-toolbox)**
  (Apache-2.0) — a suite *manager* (install, verify, update, launch). It is
  complementary: the toolbox gets the apps onto your machine, this bridge
  makes them pleasant to drive.

## Development

```sh
npm test                          # handshake + FigCraft + token-size tests
npm run test:registry             # cache miss then cache hit
npm run test:token                # list/describe, truncation, base64, preview
node tools/sync-registry.js       # pull command registries into the local cache
node tools/probe-mcp.js           # probe every app's MCP handshake + tool count
node tools/schema-size.js         # measure schema weight, refresh registry snapshots
node tools/agg-test.js            # end-to-end self-test of the bridge
node tools/per-app-verify.js      # verify each app's run argv is accepted
node tools/cursor-launch-check.js # start the bridge the way a client would
```

Zero runtime dependencies; Node ≥ 18.

Design notes: [token optimization plan](docs/token-optimization-plan.md) (Phase 1 + 2 implemented; Phase 3 deferred).

## License

MIT — see [LICENSE](LICENSE). See [NOTICE](NOTICE) for trademark attribution.
The Crafting Apps themselves are open source (MIT OR Apache-2.0) and are
developed at [github.com/storytold](https://github.com/storytold).
