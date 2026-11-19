# CSV Viewer (v0.1.0) — Design

Date: 2026-11-19
Status: Approved design, pending spec review
Extension: `get-unique-values` (publisher `boopathi08`)

## 1. Goal

Add a fast, read-only CSV viewer to the extension that opens files up to 300 MB smoothly and scales beyond (1 GB+) by never loading the whole file into memory. Users can page through rows, search, view unique values per column with counts, filter by them, and customise how columns and long cells are shown.

The existing command `get-unique-values.run` (remove duplicate and empty lines, `Ctrl+Alt+U`) is kept unchanged.

### Roadmap (each release gets its own spec → plan → implementation)

| Release | Scope |
|---|---|
| **v0.1.0 (this spec, §1-7)** | Viewer core: detect/parse, indexing, pagination, search, unique values + filter, per-column colours, long-cell handling, column show/hide (§4.3) |
| **v0.1.x features (§8, items marked M1)** | Parse presets, skip lines/comments, header row number, quote/escape chars, trim, JSONL, large-file prompt, streamed dedupe, column types, column stats, duplicate-key finder |
| **v0.2.0 (§8, M2)** | Edit & save, sort, export (JSON/JSONL/SQL/Markdown/XLSX, full unique list), split, data-quality report, more encodings, `.csv.gz`, tail mode |
| **v0.3.0 (§8, M3)** | Compare two CSVs, merge/append/join, folder-wide search, bookmarks and recent files, column masking |
| **v0.4.0** | AI prompts over CSV data: VS Code Language Model API first (Copilot models: Claude, GPT, …), optional own API keys (Anthropic / OpenAI) in SecretStorage, provider/model switch |
| later | More line tools (sort, case-insensitive unique, count duplicates, trim, show duplicates) |

Every feature below is in scope for the project; milestones only set build order. Each milestone gets its own implementation plan.

### Out of scope for v0.1.0

Everything in §8 except the column show/hide feature in §4.3 (built in v0.1.0 itself); AI features; Excel input.

## 2. Architecture

**Approach: row-offset index + on-demand reads.** A worker thread streams the file once and records the byte offset where each row starts. Pages are read from disk on demand using these offsets. Search, unique values and filters are background scans that can be cancelled, and their results are cached. Memory cost is about 8 bytes per row for the index (5M rows ≈ 40 MB) plus 4 bytes per matching row for result sets.

Rejected alternatives:
- *In-memory parse with a chunked fallback*: a 300 MB CSV becomes 1–1.5 GB of JS heap inside the shared extension host, and there would be two code paths.
- *Embedded SQLite/DuckDB (WASM)*: adds 10 MB+ to the package, needs a slow import step, and complicates packaging.

### 2.1 Entry points

- Custom editor `getUniqueValues.csvViewer` (`CustomReadonlyEditorProvider`) for `*.csv`, `*.tsv`, `*.psv`, registered with `priority: "option"`. The built-in text editor stays the default, and the viewer is chosen via "Open With…".
- Command `get-unique-values.openCsvViewer` ("Open in CSV Viewer"), exposed in:
  - the Command Palette
  - the editor title bar (when `resourceExtname` is a CSV type)
  - the Explorer context menu

### 2.2 Components

```
src/
  extension.ts            activate(): registers line tools + CSV provider/commands
  lineTools.ts            existing dedupe logic (moved, behaviour unchanged)
  csv/
    CsvEditorProvider.ts  resolves custom editor → creates CsvSession + webview
    CsvSession.ts         one per open document: owns worker, caches, view state persistence, file watcher
    protocol.ts           typed message unions: Webview⇄Session, Session⇄Worker
    worker/csvWorker.ts   worker_threads entry: index, readRows, scan jobs, cancel
    core/                 pure TypeScript, no `vscode` import (unit-testable in Node)
      detect.ts           delimiter / header / encoding / binary detection
      rowIndexer.ts       quote-aware streaming byte scanner → row start offsets
      rowParser.ts        bytes of one or more rows → string[][]
      scanner.ts          search / unique-count / filter predicates over row ranges
      resultSet.ts        Uint32Array-backed row-number lists, growable, range coalescing
media/viewer/
  main.ts               webview entry (vanilla TS, no framework)
  table.ts              renders current page, column colours, truncation, resize, pin
  toolbar.ts            search, parse-options chip, page nav, page size, column picker
  uniquePanel.ts        unique values side panel
  detailPanel.ts        cell detail + record view
  viewer.css            uses VS Code theme CSS variables
```

**Rules:**
- The extension host never parses CSV content; the worker does.
- The webview never holds more than the current page (≤ 1000 rows) plus the unique-values list it is showing.

### 2.3 Build

- Add `esbuild` (dev dependency) to bundle three outputs: `out/extension.js`, `out/csvWorker.js`, `out/viewer.js` (+ `viewer.css`).
- `tsc --noEmit` stays for type-checking, and ESLint stays as configured.
- No runtime dependencies.
- `.vscodeignore` excludes `src/`, tests and fixtures.

## 3. Data flow

### 3.1 Open

1. **Detect** (`detect.ts`) on the first 64 KB:
   - **Encoding:** BOM check (UTF-8, UTF-16LE/BE). Otherwise UTF-8, falling back to Latin-1 if invalid UTF-8 sequences are found.
   - **Binary:** a NUL byte in the sample → "binary file" message, no table.
   - **Delimiter:** candidates `,` `;` `\t` `|`. Pick the one with the most consistent non-zero field count across the first 50 quote-aware records; ties are broken in that order.
   - **Header:** on by default. Off if at least half of the first row's fields are empty, or at least half are numeric (header names are rarely numbers).
2. The toolbar shows a parse-options chip (e.g. `, · header · UTF-8`). Clicking it opens QuickPick prompts for delimiter (including a custom character), header on/off and encoding. Changing any of them re-indexes the file and clears caches.
3. **Index** (`rowIndexer.ts`) in the worker:
   - Stream 1 MB chunks and run a byte-level state machine that tracks quotes and line endings (`\n`, `\r\n`, `\r`). Its state carries across chunk boundaries.
   - Append row start offsets to a growable `Float64Array`.
   - While indexing, count rows whose field count ≠ header field count and keep their row numbers in a `resultSet` ("bad rows").
   - Emit progress every 100k rows or 250 ms: rows indexed, bytes read, total bytes.
   - Page 1 is sent as soon as `pageSize` rows are indexed.
   - Requests for pages that are not yet indexed wait until they are.
4. **Unclosed quote:** if a quoted field stays open past 1 MB or reaches end of file, the indexer records a warning (row number, byte offset), goes back to the quote start, and indexes that region line by line, ignoring quotes.

### 3.2 Paging

- The page size is chosen from 50 / 100 / 250 / 500 / 1000 (default from settings: 100). Navigation: first/prev/next/last, jump to page, jump to row.
- **Unfiltered view:** `readRows(start, count)` reads the byte range from `offset[start]` to `offset[start+count]` with one `fs.read` and parses it with `rowParser`.
- **Filtered view:** the active `resultSet` maps page rows to file rows. Consecutive file rows are merged into ranges, so each page needs as few reads as possible.
- Only the current page is posted to the webview. The session keeps a small LRU cache of the last 5 pages.

### 3.3 Search

- **Scope:** all columns or one column. **Modes:** contains (case-insensitive by default), match case, whole cell, regex. An invalid regex shows an inline error and does not start a scan.
- The worker scans the file in 4 MB chunks, aligned to row boundaries using the index, and appends matches to a new `resultSet`. Partial results stream back, so the first page of hits shows before the scan finishes.
- Progress bar with Cancel. Starting a new search cancels the running one. Each job has a job id, and stale replies are dropped.
- Search and column filters are combined with AND into a single predicate list. Any change re-runs one scan with the full list.

### 3.4 Unique values per column

- Column header menu → "Unique values" opens the side panel.
- The worker scans that one column into a `Map<value, count>` and returns entries with value, count and percentage. "(empty)" is counted as its own entry.
- The panel offers sorting by count (default, descending) or by value, has its own search box, and shows the number of distinct values.
- The display is capped at 100,000 distinct values, followed by "… and N more". The full list comes with export in v0.2.
- Ticking values creates a column filter (`column ∈ selected`), which joins the predicate list (§3.3).
- Results are cached per column + parse options, and cleared on reload or re-index.

### 3.5 File changes

A `FileSystemWatcher` on the document shows a "File changed on disk — Reload" banner. Reloading re-runs detect and index and clears all caches and result sets. A deleted file shows "File deleted" and the page that is already loaded stays visible.

## 4. Viewer UI

### 4.1 Column colours

- Hue for column *i* = `(i × 137.508°) mod 360` (golden angle). Saturation and lightness are tuned per VS Code theme kind: light, dark, high contrast. High contrast uses only a 3 px header underline in the column colour.
- Setting `getUniqueValues.csv.columnColors`: `header` | `headerAndCells` (default; header tint plus a 3 px left edge on cells) | `off`.

### 4.2 Long cells

- Cells show on one line, clipped to the column width (default 300 px), ending in `…`. The tooltip shows the first 500 characters.
- Click or Enter on a cell opens the **detail panel**:
  - the full value, wrapped
  - a "Format JSON" toggle when the value parses as JSON
  - **Copy**
  - **Open in editor tab**: an untitled document, with language `html` if the value looks like HTML, `json` if it parses as JSON, otherwise `plaintext`
- Global long-text mode `getUniqueValues.csv.longText`: `truncate` (default) | `wrap` (max 3 lines) | `full`. This can also be toggled from the toolbar.
- **Record view:** the selected row as a vertical list of column name → value, opened from the row menu or with `Shift+Enter`.

### 4.3 Column view settings

- **Column picker:** checkbox list with a search box, show all / hide all, invert, and drag to reorder. Each row shows the column colour, type icon (once §8.12 lands) and empty %.
- **Quick hide/show:** header menu → "Hide column"; a "N hidden" chip in the toolbar lists hidden columns for one-click restore.
- **Smart toggles:** "Hide empty columns" (columns with 0 non-empty values, computed from the column stats scan), "Show only columns matching…" (name pattern/regex), "Show only these columns" for the columns with an active filter or search hit.
- **Named column sets:** save the current hidden/order state as a set (e.g. "Pricing", "SEO") and switch between sets from a dropdown; sets can be included in a parse preset (§8.1).
- Shortcut: `Ctrl+Shift+H` hides the selected column, `Ctrl+Shift+U` shows all.
- **Resize** by dragging the header edge. **Pin** the first N columns (sticky). The row-number column is always shown and pinned.
- **Saved per file** in `context.workspaceState`, keyed by file path + a hash of the header row:
  - hidden columns, order, widths, pinned count
  - page size, long-text mode, colour mode, parse options
- If the header hash changes, the saved layout is ignored and the defaults apply. A "Reset view" button restores the defaults.

### 4.4 Keyboard and copy

- Arrow keys move the selected cell. PageUp / PageDown change page. `Ctrl+F` focuses search. `Ctrl+C` copies the cell value.
- The row menu has Copy row as CSV / Copy row as JSON (keyed by header).

### 4.5 Status line (in the webview)

`1,240,532 rows · 42 columns · showing 101–200 of 3,118 matches · ⚠ 312 bad rows`. Clicking the bad-rows item filters to those rows.

### 4.6 Settings (`contributes.configuration`)

| Key | Type | Default |
|---|---|---|
| `getUniqueValues.csv.defaultPageSize` | 50/100/250/500/1000 | 100 |
| `getUniqueValues.csv.columnColors` | header/headerAndCells/off | headerAndCells |
| `getUniqueValues.csv.longText` | truncate/wrap/full | truncate |
| `getUniqueValues.csv.defaultColumnWidth` | number (px) | 300 |

### 4.7 Webview security

- A strict CSP: `default-src 'none'`. Scripts and styles load only from the extension's `media`/`out` folders using a nonce. No remote content.
- All cell values are rendered with `textContent` and never with `innerHTML`, so HTML in CSV data never runs.
- `localResourceRoots` is limited to the extension's `out/` and `media/`.

## 5. Error handling

| Situation | Behaviour |
|---|---|
| Rows with wrong field count | Counted during indexing; status item; click filters to them |
| Unclosed quote | Warning with row number; region indexed line by line (§3.1.4) |
| Binary file / empty file | Message instead of table |
| Invalid regex | Inline error under search box; no scan |
| Worker crash / error | Error banner with Retry (restarts worker, re-indexes) |
| File changed / deleted | Banner (§3.5) |
| Editor closed | Session disposes: cancels jobs, terminates worker, drops caches |

## 6. Testing

- **Unit (mocha, plain Node, `test/unit/`)** for `core/`:
  - `detect`: each delimiter, header on/off heuristics, BOMs, Latin-1 fallback, binary
  - `rowIndexer`: quotes, `""` escapes, embedded `\n`/`\r\n` in quotes, CRLF/LF/CR, trailing newline or none, a BOM, **chunk boundaries splitting a quote, a `""` escape, and `\r|\n`** (each test runs every chunk size from 1 to 7 bytes), bad-row counting, unclosed-quote recovery
  - `rowParser`: field splitting, escapes, empty fields, trailing delimiter
  - `scanner`: each search mode, column scope, unique counts including empty, combined predicates, cancellation
  - `resultSet`: growth and range merging
- **Integration (`@vscode/test-electron`)**: open the custom editor on a fixture and check that the session reports page 1 with the expected row count.
- **Performance script (`scripts/perf.ts`, not in CI)** generates a synthetic 300 MB CSV (~1.5M rows, 20 columns, 1–4 KB HTML descriptions, quoted newlines). Targets on a typical laptop:
  - first page < 1 s
  - full index ≤ 10 s
  - unique values on one column ≤ 10 s
  - extension host memory increase < 100 MB
- **Manual:** real files from `~/Downloads/cdi/1_client_data` (read-only), plus a 1 GB+ file to check scaling.

## 7. Release 0.1.0

Changes to `package.json`:
- `version` → `0.1.0`
- `displayName` → `Get Unique Values & CSV Viewer`
- `description` → "Remove duplicate lines, and view huge CSV files fast: pagination, search, unique values per column, filters, column colours."
- add keywords `csv`, `csv viewer`, `large csv`, `tsv`
- extension ID `get-unique-values` and publisher `boopathi08` unchanged, so existing installs update

Other changes:
- `activationEvents`: drop `onStartupFinished`. Commands and custom editors activate the extension implicitly.
- `.vscode/extensions.json`: correct the recommendation to `boopathi08.get-unique-values`.
- README: feature list, screenshots/GIF, settings table. CHANGELOG: 0.1.0 entry.

## 8. Feature catalog (all in scope)

Milestone: **M1** = right after v0.1.0 core, **M2** = v0.2.0, **M3** = v0.3.0. All features reuse the row index and the worker scan mechanism (§2, §3.3) unless noted.

### A. Opening and parsing

| # | Feature | Design | M |
|---|---|---|---|
| 1 | Parse presets | Named profiles (delimiter, encoding, header row, quote chars, hidden columns/sets, colour mode, long-text mode). Stored in VS Code settings (`getUniqueValues.csv.presets`) so they sync. Auto-apply by glob (`*_export_*.csv`) via `filePattern`; manual pick from the options chip | M1 |
| 2 | Skip first N lines, ignore comment lines | Indexer starts at the offset after N lines; lines starting with a configurable prefix (default `#`) are excluded from the index. Row numbers shown are file-relative | M1 |
| 3 | Header row number | `headerRow` (1-based) replaces the on/off flag; rows above it are skipped, rows below form the data | M1 |
| 4 | Custom quote and escape characters | `quoteChar` (default `"`), `escapeChar` (default same as quote → `""`; option `\`). Indexer state machine and `rowParser` take these as parameters | M1 |
| 5 | Trim spaces in cells | Display-only toggle; applies in the renderer and in search/unique when "trim" is on | M1 |
| 6 | More encodings | Windows-1252, Shift-JIS, GBK, UTF-16 via `TextDecoder`; chunk decoding keeps decoder state across chunks; "Reopen with encoding" in the options chip. Row index remains in byte offsets | M2 |
| 7 | `.csv.gz` | Stream-decompress to a cache file under `globalStorageUri`, open that cache read-only, label tab with the original name; cache deleted on close or by LRU (500 MB cap) | M2 |
| 8 | JSONL / NDJSON | Same indexer with line-based rows; columns are the union of top-level keys of the first 1000 objects, nested values shown as JSON text; `*.jsonl`, `*.ndjson` added to the custom editor selector | M1 |

### B. Large files

| # | Feature | Design | M |
|---|---|---|---|
| 9 | Large-file prompt | When a CSV/TSV above `getUniqueValues.csv.largeFileMB` (default 50) opens in the text editor, show a notification "Open in CSV Viewer?" with "Don't ask again" (per workspace). Uses `onDidOpenTextDocument` | M1 |
| 10 | Tail / watch mode | Toolbar toggle; file watcher appends newly indexed rows from the last offset instead of re-indexing; view auto-scrolls to the last page when on the last page | M2 |
| 11 | Streamed dedupe | Command "Remove Duplicates (large file → new file)": streams rows, tracks seen keys in a hash set (xxhash of the key columns, or the whole line), writes unique rows to `<name>.unique.csv`. Option: dedupe by key columns; keep first or last. Existing `Ctrl+Alt+U` behaviour unchanged | M1 |

### C. Data checks

| # | Feature | Design | M |
|---|---|---|---|
| 12 | Column type detection | Sample 1000 non-empty values per column: number, integer, date, URL, email, boolean, HTML (tag regex), JSON; ≥ 95% match wins, otherwise text. Icon in the header; the user can override per column | M1 |
| 13 | Column stats panel | One scan per column, cached: empty %, distinct count (capped), min/max (numeric or lexicographic), min/max/avg length, 5 sample values. Opened from the header menu next to "Unique values" | M1 |
| 14 | Duplicate key finder | Choose one or more key columns; scan counts keys and lists those with count > 1 and their row numbers; click a key to filter to those rows | M1 |
| 15 | Data quality report | Runs 13 + 14 + bad-row detection over all columns, shows a summary table and exports it as CSV | M2 |

### D. Multiple files

| # | Feature | Design | M |
|---|---|---|---|
| 16 | Compare two CSVs | Pick two files and a key column; the worker indexes both by key (hash → row offset), reports added / removed / changed rows and which cells differ; side-by-side diff view with changed cells highlighted; export the report | M3 |
| 17 | Merge, append, join | Append files with matching headers (map columns by name); join on a key column (left/inner), streamed to a new file | M3 |
| 18 | Split | By row count, by file size, or by column value (one file per distinct value, capped at 500 files with a warning); header repeated in each part; streamed | M2 |
| 19 | Folder-wide search | Search a value (modes as §3.3) across all CSVs in a folder; results grouped by file with row numbers; click opens the viewer at that row | M3 |

### E. Viewing and export

| # | Feature | Design | M |
|---|---|---|---|
| 20 | Export formats | Current view (filtered, visible columns) to CSV, JSON, JSONL, SQL INSERT (table name prompt, escaping by dialect), Markdown table, XLSX (via a small writer, sheet limit 1,048,576 rows with a split warning). Streamed to a file | M2 |
| 21 | Bookmarks and recent files | Bookmark rows (stored per file in workspace state, with an optional note); "Recent CSV files" list reopens at the last viewed row | M3 |
| 22 | Mask columns | Toggle per column (email, phone, or custom regex); masked with `••••` in the renderer, copy and record view; one switch masks all flagged columns for screen sharing | M3 |

### Dependencies between features

- 12 (types) feeds the column picker icons (§4.3) and masking suggestions (22).
- 13 (stats) feeds "Hide empty columns" (§4.3) and 15.
- 1 (presets) bundles 2-5 and column sets (§4.3).
- 20 (export) is also required by 14, 15 and 16 for exporting their results, so build it before them.
