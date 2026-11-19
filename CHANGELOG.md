# Change Log

All notable changes to the "get-unique-values" extension are documented in this file.

## [0.2.0]

### Added
- **Excel files**: `.xlsx` and `.xlsm` files open in the CSV Viewer with a sheet picker (command **CSV Viewer: Choose Excel Sheet…**). Each sheet is converted once to a cached CSV, streamed, so large sheets work.
- **Export…** (editor toolbar and Command Palette) writes the current view or the whole file as CSV, Excel, JSON, JSON Lines, TSV, SQL INSERT or Markdown.

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
