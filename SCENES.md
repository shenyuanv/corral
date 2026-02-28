# Corral Scene Design Guide

Each scene is a visual skin over the same dashboard — same data, same sidebar, different canvas art.

---

## Architecture

- **One HTML file per scene** — all CSS/JS inline, no build step
- **No image assets** — everything procedurally drawn on canvas
- **No npm dependencies** — server.js uses Node.js built-ins only
- Copy `sv.html` as your starting template

### Grid
- 20×12 tiles, 16px per tile, 4× scale
- **Rows 0-3:** Background (wall / sky / ocean — scene-specific)
- **Rows 4-11:** Work floor (desks, agents, props — consistent across scenes)
- **8 desks max** (2 rows × 4), entry/exit at top-left of floor

---

## What Every Scene Must Have

A scene is a skin, not a fork. These functional elements must work:

### Characters
- Render agents with visual distinction by type (e.g., shirt color)
- States: walking, coding, waiting, merged, exited, sleeping
- Walk-in animation (door → desk) and walk-out (desk → door)

### Workstations
- Desk, seating, and screen per agent slot
- Screen shows activity: scrolling code when coding, PR number, error state

### Status Overlays
- Fire/flames on CI failure
- Coffee cups (or themed equivalent) for runtime
- PR badge, token bar, confetti on merge
- Notification bubbles with issue title

### Environment
- Day/night cycle tint based on real time
- Ambient particles (dust, birds, leaves — whatever fits the theme)
- Background art in rows 0-3
- Floor texture in rows 4-11

### Sound (optional but nice)
- Chiptune sound effects for state transitions (new agent, PR, merge, fail, death)

---

## Creating a New Scene

1. Copy `sv.html` → `[scene].html`
2. Keep all sidebar code, data fetching, state management — don't touch it
3. Replace the canvas drawing functions with your theme
4. Define a new color palette (`PAL` object)
5. Add route in `server.js`
6. Add scene to the sidebar scene selector
7. Test on mobile (stacked layout ≤767px)

### Draw Functions to Replace
Your scene needs themed versions of:
- Floor rendering
- Background / wall / sky
- Desk, chair, monitor
- Character sprites (all states)
- Props and decorations
- Lighting and ambient effects

### Naming
Suffix your functions: `drawFloorThai()`, `drawDeskPixel()`, etc.

---

## Scene Ideas

Map functional elements to your theme. Examples:

| Element | Office | Beach | Space | Medieval |
|---------|--------|-------|-------|----------|
| Floor | Wood/tile | Sand | Metal grating | Cobblestone |
| Background | Wall + window | Sky + ocean | Viewport + stars | Castle wall + torches |
| Desk | Office desk | Tiki table | Control console | Tavern table |
| Screen | Monitor | Laptop on stand | Holographic display | Crystal ball |
| Coffee | Coffee cup | Coconut drink | Space ration | Ale mug |
| CI fail | Fire | Tiki torch flare | Hull breach | Dragon fire |
| Merge | Confetti | Flower petals | Fireworks | Gold coins |
| Ambient | Dust motes | Seagulls, waves | Floating debris | Fireflies |
| Wanderer | Tumbleweed | Crab | Satellite | Rat |

---

## Rules

1. One file per scene — self-contained
2. Don't modify other scene files
3. All functional elements must work
4. Dark theme sidebar shared across scenes
5. Mobile responsive (CSS `order` for stacked layout)
6. Procedural canvas only — no image assets

---

*Reference: `sv.html` (SV), `thai.html` (Thai Beach), `index.html` (Classic), `pixel.html` (Pixel Office)*
