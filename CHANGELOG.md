# Change Log

All notable changes to the "get-unique-values" extension are documented in this file.

## [0.2.1]

### Added
- **Data Toolkit sidebar** in the Activity Bar (click the Data Toolkit icon). Four views: **Current File** (file info, bad rows, quick actions and saved column sets), **Tools** (launch the tools), **Recent & Favorites** (reopen or favorite recent files), and **Parse Presets** (save, apply and delete parse presets).
- **Move to first column** and **Freeze column** in the CSV Viewer header menu.
- **Duplicate checks** on chosen key columns, on whole rows, and on identical or empty columns, with **Hide extra copies**.
- Setting `getUniqueValues.csv.presets` for saved parse presets.

### Fixed
- **Export can no longer overwrite the file being viewed.** The suggested name is now `<file>-export.<ext>`, choosing the viewed file (or its cached Excel conversion) is refused, and exports are written to a temporary `.part` file that is renamed into place only when complete, so a cancelled or failed export leaves nothing behind and keeps an existing file intact.
- Closing or restarting the viewer during an export, Excel conversion or scan no longer leaves a progress notification spinning; the export reports that it stopped.
- The large-file prompt now appears for big CSV / TSV / PSV files (including files over 50 MB) and in a fresh window; the extension activates once VS Code has started.
- Excel sheets with a title row in A1 now show every column: rows are padded to the widest row instead of the first row.
- Duplicate checks on many or wide columns use far less memory, and values containing control characters are no longer merged or split.
- Excel export sheet names with characters Excel does not allow (such as `report[2024]`) no longer produce a broken workbook.
- Parse presets are saved and deleted in the workspace settings when the workspace defines them, instead of always in user settings.
- Hiding several duplicate or empty columns updates the table once; a file that shrinks on disk while open shows a reload message instead of garbled rows; the SQL export option is labelled **SQL INSERT (ANSI quoting)**.

## [0.2.0]

### Added
- **Excel files**: `.xlsx` and `.xlsm` files open in the CSV Viewer with a sheet picker (command **CSV Viewer: Choose Excel Sheet…**). Each sheet is converted once to a cached CSV, streamed, so large sheets work.
- **Export…** (the viewer's toolbar and the Command Palette) writes the current view or the whole file as CSV, Excel, JSON, JSON Lines, TSV, SQL INSERT or Markdown.

### Notes
- `.xls` and `.ods` are not supported yet.
- Fully empty rows in an Excel sheet are skipped.
- Rows are padded to the first row's width.
- Rich text stored inline by some stream writers may lose its leading runs.
- Excel sheets are converted once to a cached CSV, kept for 7 days.

## [0.1.2]

### Added
- Column type detection, shown as a hint in the column header tooltip.
- **Column stats** panel: empty %, distinct count, min / max, lengths and samples for a column (column menu).
- **Find duplicates**: scan a column for repeated values; click a value to filter the table to its rows.
- Large-file prompt: opening a CSV above the `getUniqueValues.csv.largeFileMB` size offers to open it in the CSV Viewer.

## [0.1.1]

### Changed
- Display name is now **Data Toolkit**; README documents how to install and open the extension.

## [0.1.0]

### Added
- **CSV Viewer** for `.csv`, `.tsv`, `.psv` (Open With… → CSV Viewer, editor title button, Explorer context menu).
- Streaming row index with on-demand pages: works on 300 MB+ files; first page shows while indexing continues.
- Pagination, search (all columns or one; match case / whole cell / regex; cancellable), unique values per column with counts and tick-to-filter.
- A distinct colour per column; truncate / wrap / full long-cell modes; cell detail panel (format JSON, copy, open in editor tab); record view.
- Column picker: show/hide, reorder, resize, pin, hide empty, name-pattern filter, saved column sets; layout remembered per file.
- Bad-row detection and unclosed-quote recovery; delimiter / header / encoding auto-detection with manual override.
- Retry button after a background-worker failure; `Ctrl+Shift+H` / `Ctrl+Shift+U` hide the selected column / show all columns (registered as keybinding commands); a `N hidden` chip lists hidden columns.
- Settings: `getUniqueValues.csv.defaultPageSize`, `columnColors`, `longText`, `defaultColumnWidth`.

### Changed
- The extension no longer activates at startup; it activates when a command or the CSV Viewer is used.

## [0.0.1]

- Initial release: remove duplicate and empty lines from a file or selection.
