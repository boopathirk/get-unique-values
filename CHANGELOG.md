# Change Log

All notable changes to the "get-unique-values" extension are documented in this file.

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
