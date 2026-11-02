---
name: artcraft
description: >
  Route creative-file work to the right ArtCraft app and drive it through the
  artcraft-command-bridge MCP (5 tools). Use for photo/RAW editing, logos and vector art,
  UI screens, page layout, spreadsheets, documents, slide decks, audio, video, motion
  graphics, CAD, and PDF operations with PhotoCraft, LightCraft, VectorCraft, FigCraft,
  DesignCraft, GridCraft, WordCraft, DeckCraft, SoundCraft, FilmCraft, EffectCraft,
  CADCraft, or PdfCraft — including "which app should I use?". Router only: discover
  commands live with artcraft_commands; do not preload per-app catalogs.
---

# ArtCraft — pick the app, then drive the bridge

All 13 ArtCraft apps are deterministic headless engines. They are the right tool for
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
- A PDF is the **input** → pdfcraft. A PDF is just an **export format** → use the source
  app's export.
- Data + prose in one deliverable → build the data in gridcraft, then embed/convert with
  wordcraft or deckcraft.

## 3. Discover the commands

```jsonc
{ "app": "figcraft", "filter": "node.create", "limit": 60 }
```

`artcraft_commands` returns `{ id, label, params, enabled, description }`.

- The registry is cached locally; repeat calls are a disk read, not a CLI spawn.
  Pass `refresh: true` after an app update.
- `params` is documentation (for PdfCraft, a JSON Schema **string**), not a structured
  schema — read it before composing JSON.
- `filter` matches id, label, and description. Start broad ("new", "export", "text"),
  then narrow. If truncated, narrow the filter instead of raising the limit.
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
- The result contains per-step JSON, `exit_code`, `stdout`, `stderr`. Treat a non-zero
  `exit_code`, a timeout, or `ok: false` as failure.

**Known bridge limitation:** not every app's `run` style accepts `input`/`output`.
LightCraft and EffectCraft accept neither; DesignCraft, GridCraft, DeckCraft, WordCraft,
and CADCraft accept `input` but not `output`. For those, either drive the app with
`artcraft_cli` using its own `--in`/`--save`/`--out` flags, or run the command sequence
and then a separate export/convert call.

## 5. Escape hatch — export, render, convert, info, batch

`artcraft_cli` passes argv verbatim (no shell interpretation). Use it for:

- `export` / `render` / `convert` — format changes and previews
- `info` — document summary as JSON
- `batch` — folder-level operations
- app-specific subcommands that are not command IDs

When unsure of flags: `artcraft_help({ app, args: ["run", "--help"] })` (some apps use
`["help", "run"]`). Check before guessing.

## 6. Verify before reporting

- `info` the output (pages, size, duration, layer count) and compare with the request.
- Render a PNG preview and actually look at it when the result is visual.
- Documents: confirm page count and that text is not empty.
- Media: confirm duration, dimensions, and codec.
- Report the absolute output path.

## 7. Failure map

| Symptom | What to do |
|---|---|
| `CLI not found` | App is not installed. Report the probed paths from the error; suggest install or `ARTCRAFT_<APP>_CLI`. |
| `unknown command` | Re-query `artcraft_commands`; the ID may be wrong or belong to another app. |
| Param shape error | Read that command's `params` string; keys must match exactly. |
| Export/format error | `artcraft_help` for the export subcommand; flags differ per app. |
| Timeout | Split into smaller steps or raise `timeout_ms`; video/render jobs need more. |
| Empty/blank output | Check that the document had a page/frame/element, and that save used the native format. |

## On-demand escalation (important)

This skill stays a router. When a task lands on one app:

1. Query that app's command registry with `artcraft_commands` (cached; pass
   `refresh: true` only after an app update).
2. Check its CLI help for export/import flags.
3. Only if the app becomes a repeated workload, add
   `skills/artcraft-<app>/SKILL.md` with **tested** recipes, formats, and pitfalls.

Do not create 13 app skills up front, and do not read whole 2 MB command registries —
filter them.
