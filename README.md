# Corral 🤠

Pixel art office for your coding agents. Watch them work.

Each running agent (via [Lasso](https://github.com/shenyuanv/lasso)) gets its own animated character in a virtual office. Characters walk around, sit at desks, and visually reflect what the agent is doing.

Inspired by [pixel-agents](https://github.com/pablodelucca/pixel-agents).

## Features

- **Multi-agent visualization** — every Lasso session gets a character
- **Live state tracking** — characters animate based on agent activity (coding, waiting for CI, reviewing, idle)
- **Office layout** — tile-based pixel art office
- **Standalone web app** — no VS Code required, runs in any browser
- **Lasso integration** — reads agent state from `lasso status --json`

## Quick Start

```bash
# Serve locally
npx serve .
# or just open index.html in a browser

# With live agent data (requires lasso)
lasso status --json > agents.json
```

## Status

🚧 Early prototype
