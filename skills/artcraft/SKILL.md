---
name: artcraft
description: >
  Route creative-file work to the right ArtCraft app and drive it through the
  artcraft-command-bridge MCP (5 tools). Use for photo/RAW editing, logos and vector art,
  UI screens, page layout, spreadsheets, documents, slide decks, audio, video, motion
  graphics, CAD, 3D texture painting, procedural materials, and PDF operations with
  PhotoCraft, LightCraft, VectorCraft, FigCraft, DesignCraft, GridCraft, WordCraft,
  DeckCraft, SoundCraft, FilmCraft, EffectCraft, CADCraft, TextureCraft,
  MaterialCraft, or PdfCraft — including "which app should I use?". Router only: discover
  commands live with artcraft_commands; do not preload per-app catalogs.
---

# ArtCraft — pick the app, then drive the bridge

All 15 ArtCraft apps are deterministic headless engines. They are the right tool for
exact, repeatable creative output — not image or video generation models.

## Core rules

1. **One task, one app.** Cross apps only when the deliverable changes medium (FigCraft
   screen → DeckCraft slide): app A writes a file, app B opens it.
2. **Never guess command IDs.** The live registry is authoritative. Query
   `artcraft_commands` for the chosen app before composing steps.
3. **This skill is the router only.** Do not preload or generate per-app catalogs.
   Discover command IDs with `artcraft_commands` and CLI flags with `artcraft_help`.
4. **Verify the artifact, not the exit code.** Re-open with `info` or render a preview
   and look at it.

## 1. Check what is installed

Call `artcraft_apps` first. It returns each app's `installed`, `version`, `run_style`,
and CLI path.

- `installed: false` → tell the user to install that app (getartcraft.com/apps, or set
  `ARTCRAFT_<APP>_CLI`). Do not silently substitute a different app.
- Never assume an app is present; the list changes per machine.

## 2. Route by deliverable

| App | Pick it when | Not for |
|---|---|---|
| **photocraft** | Pixel editing of existing images: retouch, composite, layers, masks, adjustments, PSD | vector logos (vectorcraft), camera RAW development (lightcraft) |
| **lightcraft** | Camera RAW, culling, non-destructive develop settings, batch variants | pixel compositing (photocraft) |
| **vectorcraft** | Paths/bezier, logos, icons, illustration, print-ready vector | pixel retouch (photocraft) |
| **figcraft** | UI screens, frames, components, design tokens, prototypes | print/page layout (designcraft) |
| **texturecraft** | 3D texture painting on meshes: texture sets, paint/fill layers, smart materials, bake and export maps | procedural material graphs (materialcraft), flat image retouch (photocraft) |
| **materialcraft** | Procedural PBR materials: node graphs, cook, render, export maps | painting/baking on a specific mesh (texturecraft) |
| **designcraft** | Multi-page print: brochures, newsletters, master pages, PDF/X | single-page UI (figcraft), slides (deckcraft) |
| **gridcraft** | Tabular data, formulas, charts, xlsx/csv | document prose (wordcraft) |
| **wordcraft** | Long-form documents, reports, letters, docx | slide decks (deckcraft), page layout (designcraft) |
| **deckcraft** | Slide decks, pptx | print layout (designcraft) |
| **soundcraft** | Audio editing, podcast, mix/master | video (filmcraft) |
| **filmcraft** | Video timeline, cuts, transitions, captions, MP4 | motion graphics (effectcraft) |
| **effectcraft** | Motion graphics, keyframes, titles, comps | live-action editing (filmcraft) |
| **cadcraft** | CAD drawings, floor plans, dimensions, DXF/DWG | vector illustration (vectorcraft) |
| **pdfcraft** | PDF page operations: merge/split, forms, OCR, redact | authoring the source document (wordcraft/designcraft) |

**Ambiguous cases**

- Still image with no layers → photocraft; needs editable vectors → vectorcraft; camera
  RAW → lightcraft.
- "Design" that is a screen → figcraft; a printed page → designcraft; a slide → deckcraft.
- Animated but not live-action → effectcraft; live-action timeline → filmcraft.
- A model needs painted/baked texture maps → texturecraft; a reusable procedural PBR
  material → materialcraft.
- A PDF is the **input** → pdfcraft. A PDF is just an **export format** → use the source
  app's export.
- Data + prose in one deliverable → build the data in gridcraft, then embed/convert with
  wordcraft or deckcraft.

## 3. Discover the commands

```jsonc
// list mode: cheap, IDs only (default limit 20)
{ "app": "figcraft", "filter": "node", "limit": 10 }

// describe mode: full params only for the commands you will run
{ "app": "figcraft", "ids": ["node.create"] }
```

`artcraft_commands` has two modes:

- **List** (default): returns `{id,label}` only. If `filter` matches ≤3 commands, it
  automatically returns full `params`; broader results stay compact.
- **Describe**: `ids:[...]` (max 8) returns full `params` for exactly those commands.

Rules:

- **Always pass `filter`** for discovery. Start broad ("new", "export", "text"), then
  narrow. Use `limit` 5–10; do not pull the whole registry.
- If the result is list mode, read `hint` and call again with `ids` for the 1–8 commands
  you will actually run. Do not ask for `detail:"full"` just to browse.
- `filter` matches id, label, and description; results are ranked (exact id first).
  Multi-word queries require every word.
- The registry is cached locally; repeat calls are a disk read, not a CLI spawn.
  Pass `refresh: true` after an app update.
- `params` is documentation (for PdfCraft, a JSON Schema **string**), not a structured
  schema — read it before composing JSON.
- `enabled: false` means unavailable right now; read `disabled_reason`.
- PdfCraft has no `commands` subcommand; the bridge maps its `tools` list into the same
  shape, so the same query works. Its tools are stateful: `doc_open` returns a `doc` id
  that later steps need — keep them in the same `artcraft_run` call.

## 4. Execute

```jsonc
{
  "app": "figcraft",
  "steps": [
    { "id": "node.create", "params": { "type": "frame", "name": "Hero", "width": 1200, "height": 800 } }
  ],
  "input": "D:/work/existing.figcraft",
  "output": "D:/work/result.figcraft"
}
```

- `steps` run in order in one engine session; each step is `{ id, params }`.
- `input` opens an existing document; omit it to start a new one (where the app supports
  a blank document).
- `output` saves in the app's **native** format. For PNG/PDF/SVG/MP4 and other exports,
  use the app's export subcommand through `artcraft_cli`.
- The result contains per-step JSON and `exit_code`. Raw `stdout` is omitted by default
  when `results` parsed; pass `include_stdout: true` only when debugging. `stderr` is
  kept (truncated) for failures.
- Output over `max_output_chars` (default 20k) is truncated; the full text is in
  `stdout_file` / `stderr_file`. Base64/image strings over `max_string_chars` (default
  4096) become `{ omitted: true, chars, type }` — never ask for them as text.
- `preview` defaults to `auto`: if the output is an image, the result gets one image
  block plus a small `preview` metadata object. Use `preview:"none"` for docx/xlsx/
  audio/video, and `preview:"image"` when a visual artifact is required.
- Treat a non-zero `exit_code`, a timeout, or `ok: false` as failure.

**Known bridge limitation:** not every app's `run` style accepts `input`/`output`.
LightCraft and EffectCraft accept neither; DesignCraft, GridCraft, DeckCraft, WordCraft,
and CADCraft accept `input` but not `output`. For those, either drive the app with
`artcraft_cli` using its own `--in`/`--save`/`--out` flags, or run the command sequence
and then a separate export/convert call.

TextureCraft and MaterialCraft use a **batch JSON** script and accept both: `input` is
an existing native project (`.tcraft` / `.sbs` / `.mcraft`), and `output` saves the
native project. To start from a mesh or a new project, use `artcraft_cli` first
(`new builtin:cube out.tcraft`, `new empty out.sbs`). Exported PNG/EXR maps are a
separate `export` call through `artcraft_cli`.

## 5. Escape hatch — export, render, convert, info, batch

`artcraft_cli` passes argv verbatim (no shell interpretation). Use it for:

- `export` / `render` / `convert` — format changes and previews
- `info` — document summary as JSON
- `batch` — folder-level operations
- app-specific subcommands that are not command IDs

For image outputs, pass `preview:"auto"` and either an `-o`/`--out`/`--export` path or
`preview_file`. The bridge validates the file (PNG/JPEG/GIF/WebP, magic bytes, ≤20 MB)
and attaches one image block. `preview_warning` means the file was missing/invalid or
larger than 4096 px; export a smaller preview before looking.

When unsure of flags: `artcraft_help({ app, args: ["run", "--help"] })` (some apps use
`["help", "run"]`). Check before guessing.

## 6. Verify before reporting

- **Visual work: look before you report done.** Render/export a PNG, inspect the image
  block, and check layout, color, cropping, truncation, and whitespace. If no image
  block came back, read the output file directly. Never claim a visual result is good
  from `exit_code: 0` alone.
- **One modification, one look.** Do not re-read the same unchanged image on every
  turn; re-render only after a change.
- **Non-visual work: no images.** For docx/xlsx/audio/video, use `preview:"none"` and
  verify metadata instead (pages, size, duration, codec, layer count).
- `info` the output and compare it with the request.
- If `preview_warning` reports >4096 px, use the app's `scale`/size flag to export a
  smaller preview; don't attach a huge image.
- Report the absolute output path.

## 7. Failure map

| Symptom | What to do |
|---|---|
| `CLI not found` | App is not installed. Report the probed paths from the error; suggest install or `ARTCRAFT_<APP>_CLI`. |
| `unknown command` | Re-query `artcraft_commands`; the ID may be wrong or belong to another app. |
| Param shape error | Read that command's `params` string; keys must match exactly. |
| Export/format error | `artcraft_help` for the export subcommand; flags differ per app. |
| Timeout | Split into smaller steps or raise `timeout_ms`; video/render jobs need more. |
| `stdout_truncated` | Read `stdout_file` if the full log is needed; otherwise the parsed `results` are enough. |
| `preview_warning` / no image block | Check the output path or pass `preview_file`; export an image with `artcraft_cli`; keep it ≤4096 px. |
| `omitted: true` in a result | That was base64/image bytes. Do not request it as text; write an image file and use preview/read. |
| Empty/blank output | Check that the document had a page/frame/element, and that save used the native format. |

## On-demand escalation (important)

This skill stays a router. When a task lands on one app:

1. Query that app's command registry with `artcraft_commands` (cached; pass
   `refresh: true` only after an app update).
2. Check its CLI help for export/import flags.
3. Only if the app becomes a repeated workload, add
   `skills/artcraft-<app>/SKILL.md` with **tested** recipes, formats, and pitfalls.

Do not create 15 app skills up front, and do not read whole 2 MB command registries —
filter them.
