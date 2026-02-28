# Corral — Agent Instructions

## Project Overview

Corral is a pixel-art dashboard that visualizes [Lasso](https://github.com/shenyuanv/lasso) coding agent sessions. It has two views:

- **Classic** (`index.html`) — original pixel art office + timeline + usage panels
- **SV** (`sv.html`) — Silicon Valley hacker-garage theme with sidebar, canvas scene, timeline, usage, and agent cards

Both are single-file HTML pages (HTML + CSS + JS inline). The backend is `server.js` (Node.js, no dependencies).

## Key Files

| File | What |
|------|------|
| `sv.html` | SV-themed dashboard (primary, ~1600 lines) |
| `index.html` | Classic dashboard (~1200 lines) |
| `server.js` | Node.js server — serves HTML + REST API (`/api/agents`, `/api/usage`, etc.) |

## Tech Stack

- **Frontend:** Vanilla HTML/CSS/JS, HTML5 Canvas (pixel art rendering)
- **Backend:** Node.js `http` module, no npm dependencies
- **Data source:** Reads `~/clawd/lasso/sessions.json` directly
- **Port:** 3377 (default)

## Running the Project

```bash
cd /path/to/corral
node server.js
# Server starts at http://0.0.0.0:3377
```

The server needs access to `~/clawd/lasso/sessions.json` to serve real data. For visual testing without lasso data, the pages still render (with "no data" states).

## Visual Verification (REQUIRED for UI changes)

**If your changes affect anything visual (CSS, canvas rendering, layout, HTML structure), you MUST verify by screenshot before marking the PR ready.**

### Steps:

1. Start the server from your workspace:
   ```bash
   node server.js &
   ```

2. Use Puppeteer (bundled with most environments) or `npx puppeteer` to take screenshots:
   ```bash
   # Install if needed
   npx puppeteer browsers install chrome

   # Take screenshot at mobile and desktop sizes
   node -e "
   const puppeteer = require('puppeteer');
   (async () => {
     const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
     const page = await browser.newPage();

     // Desktop
     await page.setViewport({ width: 1280, height: 800 });
     await page.goto('http://localhost:3377/sv.html', { waitUntil: 'networkidle0' });
     await new Promise(r => setTimeout(r, 2000)); // wait for animations
     await page.screenshot({ path: 'screenshot-desktop.png', fullPage: true });

     // Mobile portrait
     await page.setViewport({ width: 375, height: 812 });
     await page.goto('http://localhost:3377/sv.html', { waitUntil: 'networkidle0' });
     await new Promise(r => setTimeout(r, 2000));
     await page.screenshot({ path: 'screenshot-mobile.png', fullPage: true });

     // Classic view
     await page.setViewport({ width: 1280, height: 800 });
     await page.goto('http://localhost:3377/', { waitUntil: 'networkidle0' });
     await new Promise(r => setTimeout(r, 2000));
     await page.screenshot({ path: 'screenshot-classic.png', fullPage: true });

     await browser.close();
     console.log('Screenshots saved.');
   })();
   "
   ```

3. **Attach screenshots to your PR body** or commit them to the repo (in a `screenshots/` dir) so the reviewer can see the result.

4. Check both views if the change could affect either:
   - `sv.html` — the SV theme (primary)
   - `index.html` — the Classic theme

### What to verify:
- **Mobile portrait** (375×812): layout stacks correctly, no dead space, no overflow
- **Desktop** (1280×800): sidebar + canvas side by side, no overlap
- **Canvas rendering**: pixel art characters visible, animations not broken
- **Dark theme**: text readable, borders visible, no white flashes

### If Puppeteer is unavailable:
- Use `curl` to verify the server responds: `curl -s http://localhost:3377/sv.html | head -20`
- Note in the PR that screenshots could not be taken and explain why

## Code Conventions

- **Single-file HTML**: CSS and JS live inline in `<style>` and `<script>` blocks. Don't extract to external files.
- **No build step**: No bundlers, no transpilers. Edit the HTML directly.
- **No npm dependencies**: `server.js` uses only Node.js built-ins (`http`, `fs`, `path`, `child_process`).
- **Pixel art canvas**: The `<canvas>` element uses 2D context. Sprites are drawn procedurally (no image assets). Keep the retro aesthetic.
- **NES.css font**: SV view uses `"Press Start 2P"` for the pixel-art look. Don't change fonts.
- **Color scheme**: Dark background (#0a0a1a / #1a1a2e), gold accents (#f0c040), green for success, red for errors.

## Mobile Responsive

Both views must work on mobile (≤767px). Key breakpoints:
- `@media (max-width: 767px)` — mobile layout (stacked columns)
- `@media (max-width: 479px)` — small mobile (tighter spacing)

The SV view uses inline stacked layout on mobile (sidebar sections flow below canvas). No hamburger overlay.

## Testing

No test suite currently. Verify by:
1. Server starts without errors: `node server.js`
2. Pages load: `curl -s http://localhost:3377/ | grep -c '<canvas'`
3. Visual screenshot (see above) for UI changes
