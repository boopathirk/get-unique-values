# Data Toolkit

## Install and open it in VS Code

1. Open VS Code → **Extensions** (`Ctrl+Shift+X`, `Cmd+Shift+X` on macOS).
2. Search for **Data Toolkit** (publisher `boopathi08`) and click **Install**. Or run in a terminal:
   ```
   code --install-extension boopathi08.get-unique-values
   ```
   Marketplace page: <https://marketplace.visualstudio.com/items?itemName=boopathi08.get-unique-values>
3. **Open a CSV in the viewer:** right-click a `.csv` / `.tsv` / `.psv` file in the Explorer → **Open in CSV Viewer**, or click the button in the editor title bar, or use **Open With… → CSV Viewer**. The normal text editor stays the default for CSV files; `.xlsx` / `.xlsm` workbooks open in the viewer by default (see [Excel files](#excel-files)).
4. **Remove duplicate lines:** open any file, press `Ctrl+Alt+U` (`Cmd+Alt+U` on macOS), or run **Get Unique Values** from the Command Palette (`Ctrl+Shift+P`).
5. **Open the sidebar:** click the **Data Toolkit** icon in the Activity Bar (the left-hand icon column) to open the sidebar described below.

Updates arrive automatically; VS Code shows the new version in the Extensions view.

## Sidebar

The Data Toolkit icon in the Activity Bar opens a sidebar with four views:

- **Current File**: info about the open CSV or Excel file (rows, columns, delimiter, header, encoding, bad rows, hidden columns, active filter), quick actions (clear filters, hide empty columns, find duplicate rows or columns, move or freeze a column, export), and saved column sets to apply. With no file open, it shows an **Open** button.
- **Tools**: open a CSV or Excel file, remove duplicate lines from a text file, export the current view, or choose an Excel sheet.
- **Recent & Favorites**: recently opened files; reopen a file, or star it as a favorite so it stays listed.
- **Parse Presets**: save, apply and delete parse presets (delimiter, header and encoding for a file), also set in `getUniqueValues.csv.presets`.

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
| Move and freeze columns | Header menu → *Move to first column* moves a column to the first position; *Freeze column* moves it there and pins it. The sidebar's Current File view offers the same actions. |
| Duplicate checks | Column menu → *Find duplicates*, or the sidebar's *Find duplicate rows* / *Find duplicate columns*: check on chosen key columns, on whole rows, or for identical or empty columns. *Hide extra copies* keeps the first occurrence visible. |
| Bad rows | Rows whose column count differs from the first row are counted; click the warning in the status bar to list just them. |
| Auto-detect | Delimiter, header row and encoding (UTF-8 / Latin-1) are detected; click the chip in the toolbar to override. |
| Column types | Each column's detected type is shown as a hint in the header tooltip. |
| Column stats | Column menu → *Column stats*: empty %, distinct count, min / max, lengths and sample values. |
| Find duplicates | Column menu → *Find duplicates*: lists repeated values; click a value to filter the table to its rows. |
| Large-file prompt | Opening a CSV / TSV / PSV file in the text editor offers to open it in the CSV Viewer when the file is larger than `getUniqueValues.csv.largeFileMB` (default 20 MB; `0` turns the prompt off). |
| Copy | Copy a cell, or a row as CSV or JSON. |
| Open Excel files (.xlsx, .xlsm) | Open a workbook in the viewer and pick a sheet; each sheet is converted once to a cached CSV, so large sheets work. Use **CSV Viewer: Choose Excel Sheet…** to switch sheets. |
| Export and convert (CSV, Excel, JSON, JSON Lines, TSV, SQL INSERT, Markdown) | **Export…** (the viewer's toolbar or the Command Palette) writes the current filtered view or the whole file in any of these formats. The suggested name is `<file>-export.<ext>`; exporting onto the file being viewed is refused, and the file is written under a temporary name and only renamed into place when complete. |

Keyboard: arrows move the cell, `PageUp`/`PageDown` change page, `Ctrl+F` search, `Enter` cell detail, `Shift+Enter` record view, `Ctrl+C` copy cell, `Ctrl+Shift+H` hide column, `Ctrl+Shift+U` show all columns, `Esc` close panel.

### Settings

| Setting | Default | |
|---|---|---|
| `getUniqueValues.csv.defaultPageSize` | `100` | Rows per page (50, 100, 250, 500, 1000) |
| `getUniqueValues.csv.columnColors` | `headerAndCells` | `header`, `headerAndCells` or `off` |
| `getUniqueValues.csv.longText` | `truncate` | `truncate`, `wrap` or `full` |
| `getUniqueValues.csv.defaultColumnWidth` | `300` | Pixels |
| `getUniqueValues.csv.largeFileMB` | `20` | Offer the CSV Viewer for CSV / TSV / PSV files larger than this many MB; `0` turns the prompt off |
| `getUniqueValues.csv.presets` | `[]` | Saved parse presets (`name`, `delimiter`, `hasHeader`, `encoding`); managed from the sidebar's Parse Presets view. Saved to the workspace settings when the workspace defines presets, otherwise to user settings |

### Excel files

- `.xlsx` and `.xlsm` files open in the viewer by default. To use another editor for them, right-click the tab → **Reopen Editor With…**, or set it permanently with `workbench.editorAssociations`, for example `"workbench.editorAssociations": { "*.xlsx": "default" }`.
- Each sheet is converted once to a cached CSV (kept for 7 days). Every row is padded to the widest row's width, so a title in A1 does not hide the table. Fully empty rows are skipped.
- Dates are shown as ISO 8601 UTC text (for example `2024-01-02T00:00:00.000Z`); formulas show their cached result.
- `.xls` and `.ods` are not supported.

### Export notes

- **Excel**: at most 1,048,575 data rows (Excel's limit of 1,048,576 rows including the header); a longer export stops there and says so. Plain numbers become numeric cells; values such as `007` or 16+ digit numbers stay text. The sheet name is the file name with characters Excel does not allow (`[ ] : * ? / \`) replaced.
- **SQL INSERT**: uses ANSI-style quoting, `"column"` for names and `'text'` for values. It works as-is in PostgreSQL and SQLite; MySQL needs `ANSI_QUOTES` mode (`SET sql_mode = 'ANSI_QUOTES'`).

### Limitations

Read-only: the viewer does not edit or sort the file. UTF-16 files are detected but not yet supported.

## Get Unique Values

1. Open any file.
2. Select lines (or leave the selection empty to process the whole file).
3. Press `Ctrl+Alt+U` (`Cmd+Alt+U` on macOS), or run **Get Unique Values** from the Command Palette.

Duplicate lines and blank lines are removed; the first occurrence keeps its position.

---

Developed by Boopathi.
