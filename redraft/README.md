# Redraft

A Windows desktop app for editing scanned study notes with a **mouse or touchpad**, built with Electron and HTML canvas.
Open a PDF or image, and each page becomes a canvas with the original scan as a **locked background layer**. Draw, cover, retype and rearrange on layers above it, then export to print-quality PDF/PNG or a fast-forward MP4 replay.

## Install and run on Windows

### Option A: build the installer yourself (about 5 minutes)

1. Install **Node.js LTS** (20 or newer) from <https://nodejs.org>. Accept the defaults.
2. Get this folder onto your PC. Either:
   - `git clone` the repository, or
   - on GitHub, click **Code → Download ZIP** and unzip it.
3. Open **PowerShell** in the `redraft` folder (in File Explorer: open the folder, type `powershell` in the address bar, press Enter).
4. Install dependencies:
   ```powershell
   npm install
   ```
5. Try it without installing:
   ```powershell
   npm start
   ```
6. Build the installer:
   ```powershell
   npm run dist
   ```
   This creates `dist\Redraft Setup 1.0.0.exe`. Double-click it to install. You get a Start-menu entry and a desktop shortcut, and `.redraft` project files open in Redraft.

> Windows SmartScreen may say "Windows protected your PC" because the installer isn't code-signed. Click **More info → Run anyway**.

### Option B: download a ready-made installer from GitHub Actions

The workflow `.github/workflows/redraft-windows.yml` builds and tests the app on a Windows machine every time `redraft/` changes on GitHub (or when you run it by hand from the **Actions** tab → *Build Redraft for Windows* → **Run workflow**).
Open the finished run and download the **Redraft-Setup** artifact. It's a zip containing the `.exe` installer.

## Using it

| Task | How |
|---|---|
| Open scans | **Open** (Ctrl+O) a PDF, one or more images, or a `.redraft` project. You can also drag files onto the window. |
| Autosave | Opening `notes.pdf` creates `notes.redraft` next to it and saves every change there automatically. Blank notebooks autosave to the app folder until you press Ctrl+S to choose a location. |
| Smooth lines | The **Stabilizer** slider (0–100, default 55) turns shaky mouse movement into hand-drawn-looking strokes. Use `,` and `.` to adjust it. |
| Clean shapes | Draw a line, box, circle, triangle or arrow and **keep holding the button** for half a second. It snaps to a clean shape, and you can keep dragging to resize it. Shift-drag draws straight lines. |
| Ruler | **R** shows a ruler. Drag its body to move it and its round knobs to rotate it (snaps to 45°, or 15° with Shift). Strokes started along an edge come out perfectly straight. |
| Cover & rewrite | **W** paints grid paper that matches your scan (grid spacing, offset and colours are auto-detected on import). Draw over old writing, then write on top. Press **W** again for box mode, or draw a loop and hold to fill it. The **Auto-match scan grid** button and sliders fine-tune the match, and Alt+click samples the paper colour. |
| Erasers | **E** is a brush eraser; press **E** again for a whole-stroke eraser. Both only touch your layers, never the scan. |
| Text | **T**, then click and type. Fonts: Gaegu (the notes' font), Caveat, Patrick Hand, Kalam, Architects Daughter, Indie Flower (all bundled, all with natural per-letter jitter), plus Windows' Ink Free and Segoe Print. Click text to retype it and drag to move it. Use the lasso to resize, rotate or recolour it. |
| Select | **L** (or S): loop around anything, or click one item. Drag to move, use the corners to scale and the top knob to rotate. Ctrl+C / X / V / D and Delete work. Click a swatch to recolour the selection. |
| Colours | Click the colour chip for the picker. **I** is the eyedropper (or Alt+click with any brush). Swatches 1–9 (black, blue, red…) are on the number keys. **+** saves a swatch and right-click removes one. |
| Pages | Thumbnails on the left: click to open a page, drag to reorder, right-click for more. Ctrl+N adds a blank grid page, Ctrl+Shift+D duplicates, Ctrl+Shift+O inserts more PDF/image pages. |
| View | Scroll/two-finger pan, Ctrl+scroll/pinch zoom, Space+drag or middle-drag pan, Ctrl+0 fit, Tab hides the panels. |
| Export | **Export → PDF** or **PNG** at 150/300/600 dpi. Ink is re-rendered at full resolution, so it stays crisp. **Replay video (MP4)** is covered below. |

Press **F1** in the app for the full shortcut list.

## Editable notes: rebuild scanned pages as live objects

Made for the handwritten-style notes PDFs on grid paper (two columns, dated TOPIC headers, red and blue notes, highlights, dashed boxes).

1. **Open** the PDF (Ctrl+O). Redraft asks *"Make these notes editable?"*. Choose **Rebuild** for all pages, or later use **Make editable** in the top bar (Ctrl+Shift+T) on one page at a time. It takes about 8–15 s per page, fully offline.
2. Each page is rebuilt into three layers above fresh grid paper (same 46 px grid and centre divider):
   - **Text**: every line is its own text object in the notes' font (**Gaegu**), with the same colour (black, red, blue, gray), size, weight and position, snapped to the grid row.
   - **Lines & sketches**: red dashed boxes and separators, underlines, and any drawings traced into vector strokes.
   - **Highlights**: the pink and yellow highlighter bars (multiply blend, like real highlighter).
3. **Check the OCR.** Lines the reader was unsure about get an orange dotted underline (on screen only, never exported). In **Layers**, show **Original scan (compare)** to overlay the scan at 50% and spot differences. On page 1 of ARCH 595 the text came out about 96% character-accurate. Fix a line by clicking it with the **Text** tool (T) and retyping.
4. **Edit anything.** Text tool: click a line to retype it, drag it to move it. Lasso (L): select lines, boxes or sketches, then move, resize (corners), rotate (top knob), recolour (click a swatch or press 1 black / 2 blue / 3 red), copy/paste or delete. Undo is unlimited.
5. **Write new lines that match.** With the Text tool, click any empty row. The text sits on the grid line in Gaegu, and when you press Esc every letter gets its own slight size, tilt and baseline jitter (*Natural handwriting*, on by default), so it doesn't look like a font.

Every edit is recorded in the project file with timestamps: each keystroke while typing, each stroke point, erases, moves and undos.

## Replay

**Replay** in the top bar (Ctrl+Shift+R) opens the player:

- **Write the page**: animates the whole page being written by pen, letter by letter (letters are drawn along their pen strokes, not popped in), column by column, top to bottom. Highlights and underlines follow their words, boxes follow their contents, and there are a few natural slips where a word is written wrong, erased and rewritten.
- **My edits**: writes the original page, then plays back your real recorded edits, including retyping, erasing and undo.
- **Speed** 1× 2× 4× 8× 16× (keys 1–5), a **timeline scrubber**, Space to play/pause, ←/→ to skip, **Whole page** or **Follow the pen** camera.
- **Export MP4**: 1080p at 30 fps, as 1920×1080 with the camera following the pen, or 1080×1920 showing the whole page. Choose this page or all pages and the fast-forward speed. A page takes about 8 minutes of writing at 1×, so roughly 30 s of video at 16×.

## Development

```bash
npm install
npm start            # run the app
npm test             # unit tests (geometry, stabilizer, shape snapping, undo/redo model)
npm run test:e2e     # drives the real app with mouse + keyboard (on Linux: xvfb-run -a npm run test:e2e)
npm run dist         # Windows installer (run on Windows; on Linux/macOS electron-builder needs Wine)
```

Layout: `main.cjs` (window, file IO) · `preload.cjs` (safe bridge) · `src/js/core` (pure model: ops, history, geometry, shapes) · `src/js/render` (brushes, grid paper, `hand.js` natural handwriting + pen-path skeletons) · `src/js/io` (import, `rebuild.js` page analysis + OCR, project files, export, `replay.js` timeline + MP4) · `src/js/ui` (panels, replay player).

Third-party pieces (all bundled, offline): pdf.js, pdf-lib, JSZip, perfect-freehand, mp4-muxer, tesseract.js (OCR, Apache-2.0) with English data, opentype.js, and the fonts (SIL OFL).
Every edit is a serialisable operation, which is what makes unlimited undo, autosave and the replay video share one history.
