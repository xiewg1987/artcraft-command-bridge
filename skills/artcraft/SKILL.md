---
name: artcraft
description: Route deterministic creative-file work to the correct ArtCraft app and drive it through artcraft-command-bridge. Use for photo/RAW, vector/UI/print, spreadsheets, documents/slides, audio/video/motion, CAD, 2D/3D textures/materials and PDFs.
---

# ArtCraft: choose an app, discover, run, verify

ArtCraft apps are deterministic headless engines. The bridge exposes five MCP tools; command catalogs stay on disk until queried.

## Rules

1. Keep one medium in one app. Chain apps only through a saved file.
2. Never guess a command ID or CLI flag.
3. Discover narrowly, execute multiple steps in one call, and inspect the artifact before reporting success.
4. Ask for raw stdout, full parameter schemas and image previews only when they are useful.

## 1. Check installation

Call `artcraft_apps` without arguments. Its compact result contains `installed`, `missing` and `installed_count`. Use `detail:"full"` only for versions, paths or diagnostic purposes. If the app is missing, report it; do not silently substitute another app.

## 2. Route

| App | Use for | Avoid |
|---|---|---|
| `photocraft` | pixel editing, compositing, masks, PSD | RAW development; vector logos |
| `lightcraft` | camera RAW, culling, develop variants | layered pixel compositing |
| `vectorcraft` | paths, icons, logos, print vector | raster retouch |
| `figcraft` | UI screens, components, design tokens | print layout; slides |
| `designcraft` | multipage print, masters, PDF/X | single-screen UI |
| `gridcraft` | tables, formulas, charts, xlsx/csv | prose documents |
| `wordcraft` | reports, letters, long documents, docx | slides; page-layout artwork |
| `deckcraft` | slide decks, pptx | multipage print |
| `soundcraft` | audio edit, podcast, mix/master | video editing |
| `filmcraft` | live-action timeline, captions, MP4 | motion-graphics comps |
| `effectcraft` | motion graphics, keyframes, titles | live-action editing |
| `cadcraft` | CAD drawings, dimensions, DXF/DWG | illustration |
| `texturecraft` | painting/baking maps on a mesh | reusable procedural material graphs |
| `materialcraft` | procedural PBR graphs and material packages | painting a specific mesh |
| `pdfcraft` | PDF input operations, forms, OCR, redaction | source-document authoring; ordinary PDF export |

Ambiguities: screen → `figcraft`; printed page → `designcraft`; slide → `deckcraft`; still image → `photocraft`; editable path art → `vectorcraft`; RAW → `lightcraft`; PDF as input → `pdfcraft`; PDF merely as an export → use the source app.

## 3. Discover commands

```jsonc
// Broad search: IDs only, keep 5–10
{ "app": "figcraft", "filter": "node", "limit": 10 }

// Exact commands you will run
{ "app": "figcraft", "ids": ["node.create"] }
```

- `filter` matches ID, label and description; multi-word filters require every term.
- List mode returns ID strings. At most three matches are expanded automatically.
- `ids` accepts at most six commands. Each `params` string is capped at 2,400 chars by default. If `params_truncated` is true, re-query only that ID with a larger `max_param_chars` (max 12,000).
- Use `refresh:true` only after an app update. Use `cache_info:true` only for diagnostics.
- PdfCraft parameter strings are JSON Schemas. Its tools are stateful: keep `doc_open` and later steps in one `artcraft_run` call.

## 4. Execute

```jsonc
{
  "app": "figcraft",
  "steps": [
    { "id": "node.create", "params": { "type": "frame", "name": "Hero", "width": 1200, "height": 800 } }
  ],
  "input": "D:/work/input.figcraft",
  "output": "D:/work/result.figcraft",
  "preview": "none"
}
```

- Steps run in order in one engine session. `input` opens an existing file; `output` uses the app-specific save/export mapping.
- Results are compact: repeated `command`, `id`, `ok` and `status` wrappers are removed. A failure appears in `errors` and nonzero `exit_code`.
- Raw stdout is omitted when parsed results exist. Use `include_stdout:true` only for debugging.
- Default caps: raw output 6,000 chars, structured result 8,000 chars, long base64/image strings 2,048 chars. Full payloads are written to `stdout_file`, `stderr_file` or `results_file`.
- `preview` defaults to `none`. For visual acceptance, export an image no larger than 1,024px on the longest side and set `preview:"auto"`; use `preview:"image"` when a preview must be returned. Limit: 4MB.

Common support:

- Full generic file input/output: PhotoCraft, VectorCraft, SoundCraft, FilmCraft, FigCraft, EffectCraft, TextureCraft, MaterialCraft.
- File export through `output`: DesignCraft, GridCraft, DeckCraft, WordCraft, CADCraft.
- SoundCraft `.scraft` saves a session; audio extensions use bounce.
- TextureCraft/MaterialCraft `output` saves the native project. Export PNG/EXR maps with `artcraft_cli export`.
- LightCraft uses CLI-specific `--import`, `--library`, `--script`, render or export paths through `artcraft_cli`.
- PdfCraft `output` is mainly for image-producing tools; document outputs normally come from the selected tool parameters.

## 5. Escape hatch

Use `artcraft_cli` for `export`, `render`, `convert`, `info`, folder batches and app-specific subcommands that are not command IDs. Arguments are passed without shell interpretation. JSON stdout is parsed automatically; raw stdout is opt-in.

For an image preview, add `preview:"auto"` and either an image `-o`/`--out`/`--export` path or `preview_file`. Use `artcraft_help` when flags are uncertain; its output is capped at 6,000 chars by default.

## 6. Verify

- Visual work: render/export a small preview, inspect the image block, then check layout, color, crop, truncation and whitespace. If no image came back, inspect the output path.
- Read the same unchanged image once. Re-render after a change.
- Nonvisual work: use `preview:"none"` and verify metadata such as pages, dimensions, duration, codec or layer count.
- Report the absolute output path. Never claim success from `exit_code: 0` alone.

## Failure map

| Symptom | Action |
|---|---|
| App in `missing` | Install it or set `ARTCRAFT_<APP>_CLI`. |
| Unknown command/parameters | Re-query the exact ID and inspect `params`. |
| `stdout_truncated` / `results_truncated` | Read the referenced file only if needed. |
| `preview_warning` | Fix the path or export a smaller PNG/JPEG/WebP/GIF. |
| `omitted: true` | This is binary/base64 data; write a file and preview it. |
| Timeout | Split the job or raise `timeout_ms` for video/render work. |

## Token discipline

Use `filter` plus `limit` 5–10, then `ids` for only the commands being executed. Put multiple operations in one `artcraft_run`. Do not request raw stdout, full parameter catalogs or image previews routinely. For tasks with several unrelated stages, prefer a few compact calls over repeatedly fetching large command descriptions.
