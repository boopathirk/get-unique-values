# Data Toolkit

Two tools in one extension:

1. **Get Unique Values**: remove duplicate and empty lines from a file or selection (`Ctrl+Alt+U`).
2. **CSV Viewer**: open huge CSV / TSV / PSV files (300 MB and well beyond) in a fast table with pagination, search, unique values per column, filters, per-column colours and full control over which columns are shown.

## CSV Viewer

Open a file with **right-click → Open in CSV Viewer**, the button in the editor title bar, or **Open With… → CSV Viewer**. The normal text editor stays the default for `.csv` files.

| Feature | What it does |
|---|---|
| Large files | The file is indexed once in a background thread and pages are read from disk on demand. Page 1 appears immediately while indexing continues. |
| Pagination | 50 / 100 / 250 / 500 / 1000 rows per page, first / previous / next / last, jump to page or to a row number. |
| Search | All columns or one column; match case, whole cell, regular expression; streamed results with progress and Cancel. |
| Unique values | Column menu → *Unique values*: every distinct value with count and percentage. Tick values to filter the table. |
| Column colours | Every column header (and cell edge) gets its own colour, adapted to light, dark and high-contrast themes. |
| Long cells | One truncated line by default (or 3 wrapped lines, or full). Double-click a cell for the full value; format JSON, copy, or open it in an editor tab (HTML/JSON highlighting). |
| Record view | See one row as a vertical column → value list. |
| Show / hide columns | Column picker with search, show all / hide all / invert, drag to reorder, *Hide empty*, *Only filtered*, name-pattern filter, saved column sets, pin the first N columns, resize by dragging. Everything is remembered per file. |
| Bad rows | Rows whose column count differs from the first row are counted; click the warning in the status bar to list just them. |
| Auto-detect | Delimiter, header row and encoding (UTF-8 / Latin-1) are detected; click the chip in the toolbar to override. |
| Copy | Copy a cell, or a row as CSV or JSON. |

Keyboard: arrows move the cell, `PageUp`/`PageDown` change page, `Ctrl+F` search, `Enter` cell detail, `Shift+Enter` record view, `Ctrl+C` copy cell, `Ctrl+Shift+H` hide column, `Ctrl+Shift+U` show all columns, `Esc` close panel.

### Settings

| Setting | Default | |
|---|---|---|
| `getUniqueValues.csv.defaultPageSize` | `100` | Rows per page (50, 100, 250, 500, 1000) |
| `getUniqueValues.csv.columnColors` | `headerAndCells` | `header`, `headerAndCells` or `off` |
| `getUniqueValues.csv.longText` | `truncate` | `truncate`, `wrap` or `full` |
| `getUniqueValues.csv.defaultColumnWidth` | `300` | Pixels |

### Limitations in 0.1.0

Read-only (editing, sorting, export and AI prompts are planned). UTF-16 files are detected but not yet supported.

## Get Unique Values

1. Open any file.
2. Select lines (or leave the selection empty to process the whole file).
3. Press `Ctrl+Alt+U` (`Cmd+Alt+U` on macOS), or run **Get Unique Values** from the Command Palette.

Duplicate lines and blank lines are removed; the first occurrence keeps its position.

---

Developed by Boopathi.
