# Corral Scene Design Guide

How to create new themed scenes for Corral. Each scene is a visual skin over the same functional dashboard — same data, same sidebar, different canvas art.

---

## Architecture Overview

Corral uses a **single-file HTML architecture** per scene. Each scene file (`index.html` = Classic, `sv.html` = Silicon Valley) contains inline CSS + JS with no external dependencies (except CDN fonts/CSS frameworks).

### Canvas System
- **Grid:** `COLS × ROWS` tiles (currently 20×12)
- **Tile size:** `TILE = 16` logical pixels
- **Scale:** `SCALE = 4` (canvas renders at 4x for crisp pixel art)
- **Total canvas:** 1280×768 physical pixels (320×192 logical)
- **Coordinate system:** Tile-based. `tileRect(col, row, w, h, color)` draws at grid positions.

### Key Constants
```js
const TILE = 16, SCALE = 4, S = TILE * SCALE;  // S = 64px per tile on screen
const COLS = 20, ROWS = 12;                      // 20 tiles wide, 12 tall
const DOOR_TILE = { x: 0, y: 4 };               // Entry/exit point at top of work floor
```

---

## Standard Layout (MANDATORY for all scenes)

All scenes use a **4-row background + 8-row work floor** layout:

```
Row  0 ┌─────────────────────────────┐
Row  1 │     BACKGROUND ZONE         │  4 rows (64 logical px)
Row  2 │     (wall / sky / ocean)    │  Scene-specific decorations
Row  3 │                             │
       ├─────────────────────────────┤  ← floor starts here (row 4)
Row  4 │                             │
Row  5 │  ██ desk row 1 (y=5)  ██   │  8 rows (128 logical px)
Row  6 │                             │  WORK ZONE
Row  7 │                             │  Desks, chairs, agents, props
Row  8 │  ██ desk row 2 (y=8)  ██   │  2 rows of 4 desks (max 8 agents)
Row  9 │                             │
Row 10 │                             │
Row 11 │                             │
       └─────────────────────────────┘
```

### Background Zone (Rows 0-3)
4 tile rows = 64 logical pixels. Content varies by scene:

| Scene   | Rows 0-1              | Rows 2-3                |
|---------|-----------------------|-------------------------|
| SV      | Ceiling, ductwork     | Wall art, window, signs |
| Classic | Wall top, window      | Wall, door frame        |
| Thai    | Sky, clouds, sun      | Ocean, waves, foam      |

### Work Zone (Rows 4-11)
8 tile rows = 128 logical pixels. Consistent across all scenes:

- **Desk row 1:** y=5 (tiles at x=2, 7, 12, 17)
- **Desk row 2:** y=8 (tiles at x=2, 7, 12, 17)
- **DOOR_TILE:** `{ x: 0, y: 4 }` — agent entry/exit at top of floor
- **Max agents:** 8 (4 per row, 2 rows)

Desk generation (same across all scenes):
```js
const DESKS = [];
for (let r = 1; r < 3; r++)
  for (let c = 0; c < 4; c++)
    DESKS.push({ x: 2 + c * 5, y: 2 + r * 3 }); // y=5, y=8
```

---

## Functional Elements (Required in Every Scene)

These elements MUST exist in every scene — they represent actual data. The visual style changes, but the function stays.

### 1. Agent Characters
**What:** 16-bit sprites representing coding agents (Codex, Claude Code, etc.)
**Data:** Agent ID, state, agent type, runtime, tokens used
**States & required poses:**

| State | Pose | Description |
|-------|------|-------------|
| `walking` | Legs moving, arms swinging | Walk-in (door→desk) or walk-out (desk→door) |
| `coding` | Seated, hands typing, head bobbing | Actively working on issue |
| `reading` / `waiting` | Seated, one hand raised | PR open, waiting for CI/review |
| `merged` | Arms raised, celebration | PR merged successfully |
| `exited` / `dead` | Slumped | Agent died or crashed |
| `sleeping` | ZZZ floating | Idle/paused |
| `ci_failed` | Seated (with fire nearby) | CI failing, agent retrying |

**Visual differentiation by agent type:**
- Codex agents: green accent (hoodie/shirt)
- Claude agents: orange accent
- Other: use `colorIdx` to cycle through palette

**Functions:**
- `drawCharacter[SCENE](d, colorIdx, state, agentType)` — Main sprite renderer
- Character palette: `CHARS_[SCENE]` array with skin/hair/clothing variations

### 2. Desks & Workstations
**What:** Where agents sit and work
**Data:** Position in grid, agent assignment
**Layout:** `DESKS` array — 8 positions (2 rows × 4 columns)

**Functions:**
- `drawDesk[SCENE](d, idx, agentType)` — Desk furniture
- `drawChair[SCENE](d, idx)` — Chair/seating
- `drawMonitor[SCENE](d, state, monitorText, idx, agentType)` — Screen showing agent activity

**Monitor must show:**
- Scrolling code lines when coding
- PR number when PR is open
- Error/red when CI failed
- Cursor blink animation
- Issue title text (scrolling)

### 3. Walk Animations
**What:** Agents walk in when spawned, walk out when done
**Data:** Transition state, path from door to desk (and reverse)

**Functions:**
- `buildPath(start, end)` — A* or simple L-path between two tiles
- Walk-in: `DOOR_TILE → desk position` (new agent appears)
- Walk-out: `desk position → DOOR_TILE` (merged/exited agent leaves)
- `positionAlongPath(path, progress)` — Interpolate position

**Timing:**
- Walk-in: ~2-3 seconds
- Walk-out (merged): 1.5s celebration delay → 3s walk
- Walk-out (exited): 0.5s delay → 2s walk (faster)

### 4. Status Indicators (Per-Agent)
**What:** Visual overlays showing agent status
**Data:** Various agent metrics

| Indicator | Function | When shown |
|-----------|----------|------------|
| Fire/flames | `drawFire(d)` | CI is failing |
| Tombstone | `drawTombstone(d)` | Agent dead (with walk-out, may be deprecated) |
| Coffee cups | `drawCoffeeCups(d, count)` | Runtime indicator (1 cup per hour) |
| PR badge | `drawPrBadge(d, num, merged)` | PR number floating near agent |
| Token bar | `drawTokenBar(d, pct)` | Token usage progress bar |
| Confetti | `drawConfetti(d)` | Celebration on merge |
| Notification bubble | `drawBubble(d, text, color)` | Scrolling issue title |
| Thought bubble | `drawThoughtBubble[SCENE](d, idx)` | Coding focus indicator (`...`, `</>`, `{}`) |
| Keyboard glow | `drawKeyboardGlow[SCENE](d, idx)` | RGB glow under typing hands |

### 5. Day/Night Cycle
**What:** Canvas tint changes based on real local time
**Data:** Current hour → `getTimeOfDay()` returns `{ nightFactor, warmFactor, hour }`

**Required:**
- `drawDayNightOverlay()` — Full-canvas tint layer
- `drawLighting[SCENE]()` — Scene-specific light sources that intensify at night
- Window/sky elements should reflect time (stars at night, sun during day)
- Fluorescent/artificial lights brighter at night

### 6. Ambient Effects
**What:** Particles and animations that make the scene feel alive
**Data:** Frame counter (`frame` increments each render)

**Required particles:**
- Dust motes (floating upward, subtle)
- Scene-specific particles (sparkles, leaves, snow, etc.)
- Managed via `particles[]` array, updated each frame

### 7. Sound Effects (Optional but Expected)
**What:** 8-bit chiptune sounds for events
**Data:** State transitions detected in `detectSoundEvents()`

| Event | Sound |
|-------|-------|
| New agent | Door chime |
| PR opened | Level-up |
| CI failed | Error buzz |
| Merged | Victory fanfare |
| Agent died | Game over |

---

## Scene-Specific Elements (The Fun Part)

These are unique to each scene and define its personality.

### Environment Art
Each scene needs a complete environment drawn in the render pipeline:

```
┌─────────────────────────────────────────────┐
│ Background (rows 0-3)  — BACKGROUND ZONE    │
│   Wall/sky/ocean, decorations, windows      │
├─────────────────────────────────────────────┤
│ Floor area (rows 4-11) — WORK ZONE          │
│   Desks, chairs, agents, props              │
│   Walkways between desk rows                │
│   Floor texture and details                 │
└─────────────────────────────────────────────┘
```

**Required draw functions for a scene:**
```
drawFloor[SCENE]()        — Ground texture (wood, sand, grass, tiles...)
drawWalls[SCENE]()        — Back wall / horizon / sky
drawProps[SCENE]()        — Decorative objects (themed to scene)
drawLighting[SCENE]()     — Light sources, glow effects, shadows
```

### Color Palette
Each scene defines a `PAL` object with all colors. Follow naming convention:

```js
const PAL = {
  // Base environment (every scene needs these)
  floor1: '...', floor2: '...', floor3: '...', floor4: '...',
  wall: '...', wallDark: '...', wallLight: '...',
  desk: '...', deskTop: '...', deskDark: '...',
  monitor: '...', monitorBezel: '...',
  
  // Scene-specific (prefix with scene abbreviation)
  [sc]Floor1: '...', [sc]Floor2: '...',
  [sc]Prop1: '...', [sc]Prop2: '...',
  // ... etc
};
```

---

## Render Pipeline (Draw Order)

The render function draws back-to-front. This order matters for layering:

```js
function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  frame++;
  
  // 1. BACKGROUND LAYER
  drawFloor[SCENE]();        // Ground texture
  drawWalls[SCENE]();        // Back wall / sky / horizon
  // Scene-specific background structures
  drawWindow();              // or drawOcean(), drawVolcano(), etc.
  drawDoor();                // Entry/exit point
  
  // 2. ENVIRONMENT LAYER
  drawLighting[SCENE]();     // Ambient light, glow sources
  drawDividers();            // Visual separation between desk groups
  drawProps[SCENE]();        // Decorative objects
  
  // 3. FURNITURE LAYER (per agent)
  agents.forEach(a => {
    drawDesk[SCENE](d, idx, agentType);
    drawChair[SCENE](d, idx);
    drawMonitor[SCENE](d, state, text, idx, agentType);
  });
  
  // 4. CHARACTER LAYER (per agent)
  agents.forEach(a => {
    drawCharacter[SCENE](d, colorIdx, state, agentType);
    // Status indicators
    drawTokenBar(d, tokens);
    drawKeyboardGlow[SCENE](d, idx);
    drawThoughtBubble[SCENE](d, idx);
    drawCoffeeCups(d, coffees);
    drawFire(d);                    // if CI failing
    drawPrBadge(d, prNum, merged);
    drawBubble(d, label, color);
    drawConfetti(d);                // if merged
  });
  
  // 5. WALKING CHARACTERS (on top of everything)
  walkIns.forEach(t => drawCharacter[SCENE](pos, ...));
  walkOuts.forEach(w => drawCharacter[SCENE](pos, ...));
  
  // 6. FOREGROUND LAYER
  drawTumbleweed();           // or scene equivalent (birds, fish, etc.)
  drawPlants();               // or scene equivalent
  // Ambient particles
  
  // 7. OVERLAY LAYER
  drawDayNightOverlay();      // Time-based tint (ALWAYS last)
  
  requestAnimationFrame(render);
}
```

---

## Scene Ideas & Visual Mapping

How functional elements translate to different themes:

### 🏖️ Hawaii Beach
| Functional Element | Visual Translation |
|---|---|
| Office walls | Ocean horizon + palm trees + sunset sky |
| Wooden floor | Sandy beach with wave edges |
| Desks | Tiki bar tables / surfboard desks |
| Chairs | Beach chairs / hammocks |
| Monitors | Coconut shell screens / tablet on stand |
| Door (entry/exit) | Beach path from jungle |
| HACK neon sign | Tiki torch with "ALOHA" |
| Whiteboard | Message in a bottle / beach sign |
| Dart board | Coconut target game |
| Guitar | Ukulele on palm tree |
| Fire (CI fail) | Tiki torch flames |
| Tombstone (dead) | Buried in sand mound |
| Coffee cups | Cocktail glasses with umbrellas |
| Confetti (merge) | Flower petals / lei toss |
| Day/night cycle | Sunset colors, stars over ocean, bioluminescent waves |
| Particles | Sand grains, seagulls, fireflies at night |
| Keyboard glow | Bioluminescent glow |
| Walk animation | Walk on sand (footprints behind) |
| Props | Surfboards, cooler, flip flops, crab, sea shells |
| Sound effects | Ocean waves, steel drums, seagull cries |

### 🦕 Jurassic Park
| Functional Element | Visual Translation |
|---|---|
| Office walls | Jungle canopy + electric fence + volcano in distance |
| Floor | Mud/dirt path with fern patches |
| Desks | Field research stations / jeep hoods |
| Chairs | Camp stools / log seats |
| Monitors | Ruggedized field laptops / old CRT terminals |
| Door (entry/exit) | Jurassic Park gate (iconic arch) |
| Neon sign | "LIFE FINDS A WAY" amber glow sign |
| Whiteboard | Map of Isla Nublar |
| Fire (CI fail) | Raptor approaching desk! |
| Tombstone (dead) | Dinosaur footprint crater |
| Coffee cups | Canteen water bottles |
| Confetti (merge) | Amber particles + DNA helix sparkle |
| Day/night cycle | Storm clouds at night, lightning flashes |
| Particles | Fireflies, falling leaves, rain drops |
| Walk animation | Sneaking carefully (raptors nearby) |
| Props | Dinosaur eggs, amber specimen, night vision goggles, electric fence warning sign |
| Ambient | Occasional dinosaur silhouette walking in background |
| Sound effects | Raptor screech, T-Rex roar (merge), rain, electric fence buzz |

### 🏰 Medieval Castle / RPG Dungeon
| Functional Element | Visual Translation |
|---|---|
| Walls | Stone castle walls with torches |
| Floor | Cobblestone / dungeon floor |
| Desks | Wooden tavern tables / alchemy benches |
| Monitors | Magic crystal balls / enchanted scrolls |
| Door | Drawbridge / portcullis |
| Sign | Enchanted rune banner |
| Fire (CI fail) | Dragon breathing fire |
| Confetti (merge) | Gold coins / treasure shower |
| Characters | Knights / wizards / rogues (by agent type) |

### 🚀 Space Station
| Functional Element | Visual Translation |
|---|---|
| Walls | Viewport showing Earth/stars/nebula |
| Floor | Metal grating with glow strips |
| Desks | Control consoles with holographic displays |
| Monitors | Holographic screens |
| Door | Airlock |
| Fire (CI fail) | Hull breach sparks |
| Day/night | Orbital day/night (Earth rotation through viewport) |
| Characters | Astronauts in color-coded suits |
| Particles | Floating debris, distant satellites |

---

## Creating a New Scene: Checklist

### Phase 1: Setup
- [ ] Copy `sv.html` as template → `[scene].html`
- [ ] Update page title and theme CSS variables
- [ ] Choose CSS framework (SNES.css for pixel art, or custom)
- [ ] Define new `PAL` colors for the scene
- [ ] Define `CHARS_[SCENE]` character palette (skin/hair/clothing appropriate to theme)

### Phase 2: Environment
- [ ] `drawFloor[SCENE]()` — Ground texture
- [ ] `drawWalls[SCENE]()` — Back wall/horizon/sky with decorations
- [ ] `drawProps[SCENE]()` — 6-10 scene-specific decorative objects
- [ ] `drawLighting[SCENE]()` — Light sources, glow, shadows
- [ ] Update `drawDayNightOverlay()` tint colors if needed

### Phase 3: Furniture
- [ ] `drawDesk[SCENE](d, idx, agentType)` — Themed workstations
- [ ] `drawChair[SCENE](d, idx)` — Themed seating
- [ ] `drawMonitor[SCENE](d, state, text, idx, agentType)` — Themed screens

### Phase 4: Characters
- [ ] `drawCharacter[SCENE](d, colorIdx, state, agentType)` — All state poses
- [ ] Agent type differentiation (Codex vs Claude visual)
- [ ] Walk cycle animation (4 frames minimum)
- [ ] `drawThoughtBubble[SCENE]()` — Coding indicators
- [ ] `drawKeyboardGlow[SCENE]()` — Typing visual

### Phase 5: Ambient
- [ ] Initialize scene-specific particles
- [ ] Background movement (birds, clouds, fish, etc.)
- [ ] Scene-specific tumbleweed equivalent (wandering creature/object)
- [ ] Sound effects mapping (8 events minimum)

### Phase 6: Server Integration
- [ ] Add route in `server.js`: `app.get('/[scene]', ...)`
- [ ] Add scene option to sidebar scene selector
- [ ] Test with real session data
- [ ] Mobile responsive layout
- [ ] Screenshot for scene preview

---

## File Structure
```
corral/
├── server.js          — Node.js server (routes, API, WebSocket)
├── index.html         — Classic 8-bit scene
├── sv.html            — Silicon Valley scene
├── [scene].html       — New scene (self-contained)
├── SCENES.md          — This document
├── CLAUDE.md          — Agent instructions
└── AGENTS.md          — Agent instructions (copy)
```

---

## Rules

1. **One file per scene** — all CSS/JS inline, no external assets
2. **No npm dependencies** — server.js uses Node.js built-ins only
3. **No image assets** — everything is procedurally drawn on canvas
4. **All functional elements must work** — a scene is a skin, not a fork
5. **Name scene functions with suffix** — `drawFloorSV()`, `drawFloorBeach()`, etc.
6. **Don't modify other scenes** — changes to beach.html must not affect sv.html
7. **Dark theme sidebar** — all scenes share the dark UI aesthetic for sidebar
8. **Mobile responsive** — stacked layout below 767px

---

*Created 2026-02-28. Reference: sv.html (Silicon Valley scene), index.html (Classic scene).*
