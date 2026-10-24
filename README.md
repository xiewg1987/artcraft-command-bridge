# artcraft-command-bridge

**One MCP server for the 13 [ArtCraft Crafting Apps](https://getartcraft.com/apps) — 5 tools instead of 799.**

Each Crafting App ships its own MCP server that exposes every engine command as a
separate tool. Registering all 13 of them costs **799 tools / 547 KB of schema ≈
140k tokens of permanently resident context**, and that payload is re-sent on
*every* request.

This bridge drives the apps' CLIs instead and exposes **5 tools / 3.5 KB**.

```
799 tools · 547.3 KB · ~140,000 tokens   →   5 tools · 3.5 KB · ~900 tokens
```

---

## Why this exists

MCP clients register a server's tool list in full. The protocol has no
"just give me the names, fetch the schema on demand" mode — the client calls
`tools/list` once and keeps every tool's `name` + `description` +
`inputSchema` in the system payload forever. Some clients have an on-demand
tool *search* facility, but that covers deferred tools (cron, integrations),
not MCP server tools.

The Crafting Apps already share one model that is perfect for this:

- `commands` — lists stable command IDs with their parameters
- `run` — executes those IDs

Measured across the 13 apps, that is **7027 command IDs**. The 799 tools the
apps' own MCP servers expose are only a subset view of the same registry. So
the tools do not need to be flattened into 799 separate entries — they need a
**directory** and a **dispatcher**, which is what this is.

Only PdfCraft ships an on-demand mode of its own (`pdfcraft-cli mcp --compact`,
which exposes a core set plus `tool_search`/`tool_call`); the other twelve reject
`--compact` outright, so there was no unified switch to simply turn on.

## Quick start

1. Install the apps you want — see [getartcraft.com/apps](https://getartcraft.com/apps).
   Each app installs a `<app>-cli` binary.

2. Register this server with your MCP client:

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

   Or with the official installer:

   ```sh
   npm install -g artcraft-command-bridge
   ```

3. Restart the client so the tools load.

## The 5 tools

| Tool | What it does |
|---|---|
| `artcraft_apps` | The 13 apps: purpose, version, install status, and how their `run` argv is built. Start here. |
| `artcraft_commands` | An app's stable command IDs with parameter docs. Filter by substring. |
| `artcraft_run` | Execute one or more command IDs in order. The deterministic path. |
| `artcraft_cli` | Escape hatch — run any CLI subcommand verbatim (`export`, `render`, `convert`, `info`, `batch`). |
| `artcraft_help` | An app's own `--help` text. |

### Example

```jsonc
// what can figcraft do?
{ "app": "figcraft", "filter": "node.create" }

// build a frame
{
  "app": "figcraft",
  "steps": [
    { "id": "node.create", "params": { "type": "frame", "name": "Hero", "width": 1200, "height": 800 } }
  ],
  "output": "D:/out/hero.figcraft"
}

// export it (not a command ID — use the escape hatch)
{ "app": "figcraft", "args": ["export", "hero.figcraft", "-o", "hero.png", "--format", "png", "--node", "Hero"] }
```

## How it works

Every app's `run` takes its commands in a slightly different shape. The bridge
translates one uniform `{ id, params }` model into each app's own syntax:

| argv style | apps |
|---|---|
| `--cmd <id> --params <json>` | PhotoCraft, VectorCraft |
| `--cmd <id>={<json>}` | DesignCraft, GridCraft, SoundCraft, DeckCraft, WordCraft |
| `--cmd '<id> <json>'` | CADCraft |
| positional `<id> <json>` | LightCraft, EffectCraft |
| script file `run <script.json>` | FigCraft (`{command, params}`) |
| script file `run <script.jsonl>` | FilmCraft (`{id, params}`) |
| `run <tool> key=value` | PdfCraft (tool names, not command IDs) |

The command registry is exposed differently too, so the bridge normalises it:

| registry shape | apps |
|---|---|
| `commands --json` | PhotoCraft, VectorCraft, FigCraft, GridCraft, LightCraft, EffectCraft, FilmCraft, WordCraft |
| `commands` (plain JSON) | CADCraft, DesignCraft — their `--json` flag is parsed as a filter and returns `[]` |
| plain-text table | DeckCraft, SoundCraft |
| `tools` subcommand | PdfCraft has no `commands` at all |

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

## Why not an existing tool?

- **[eznix86/mcp-gateway](https://github.com/eznix86/mcp-gateway)** (MIT) — a
  general-purpose gateway with the same idea, but it aggregates *MCP servers*,
  so the 13 Crafting App servers still have to be running as upstream
  processes, and its `search` is text-similarity rather than an exact
  registry lookup.
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
node tools/probe-mcp.js           # probe every app's MCP handshake + tool count
node tools/schema-size.js         # measure schema weight, refresh registry snapshots
node tools/agg-test.js            # end-to-end self-test of the bridge
node tools/per-app-verify.js      # verify each app's run argv is accepted
node tools/cursor-launch-check.js # start the bridge the way a client would
```

Zero runtime dependencies; Node ≥ 18.

## License

MIT — see [LICENSE](LICENSE). See [NOTICE](NOTICE) for trademark attribution.
The Crafting Apps themselves are open source (MIT OR Apache-2.0) and are
developed at [github.com/storytold](https://github.com/storytold).
