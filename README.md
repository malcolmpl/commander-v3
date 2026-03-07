# SpaceMolt Commander v3

Autonomous fleet management system for [SpaceMolt](https://spacemolt.com) — a multiplayer space MMO. Commander v3 runs a fleet of bots that mine, trade, craft, explore, and fight across the galaxy, coordinated by an AI brain that evaluates the fleet state and assigns optimal routines every 60 seconds.

## Architecture

```
config.toml          ← Fleet config, brain selection, goals
src/app.ts           ← Entry point
src/startup.ts       ← Wires all services together
src/bot/             ← Bot lifecycle, login, session management
src/commander/       ← AI brain system (scoring, ollama, gemini, claude, tiered)
src/core/            ← API client (151 endpoints), galaxy graph, market engine
src/routines/        ← 14 async generator routines (miner, trader, crafter, etc.)
src/server/          ← Bun HTTP/WebSocket server, message router, broadcast loop
src/data/            ← SQLite via Drizzle ORM, game cache, training logger
src/events/          ← Event handlers (trade tracking, production, faction)
src/fleet/           ← Fleet persistence, discovery
web/                 ← Svelte 5 + SvelteKit dashboard
```

## Tech Stack

- **Runtime**: [Bun](https://bun.sh) + TypeScript
- **Database**: SQLite via [Drizzle ORM](https://orm.drizzle.team)
- **Frontend**: Svelte 5 + SvelteKit + Tailwind CSS
- **AI**: Tiered brain system — Ollama (local) → Gemini → Claude → scoring fallback
- **Real-time**: WebSocket protocol between backend and dashboard

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) v1.0+
- SpaceMolt accounts (register at [spacemolt.com](https://spacemolt.com))
- (Optional) [Ollama](https://ollama.ai) for local AI brain

### Setup

```bash
# Install dependencies
bun install
cd web && bun install && cd ..

# Configure
cp config.toml.example config.toml  # Edit with your settings

# Run
bun run dev        # Backend with hot reload
bun run dev:web    # Dashboard dev server (separate terminal)
```

### Configuration

Edit `config.toml` (see `config.toml.example` for all options):

```toml
[commander]
brain = "tiered"              # "scoring", "ollama", "gemini", "claude", "tiered"
evaluation_interval = 60      # Seconds between fleet evaluations
reassignment_cooldown = 300   # Seconds before a bot can be reassigned

[ai]
ollama_model = "qwen3:8b"
gemini_model = "gemini-2.5-pro"
claude_model = "claude-3-5-haiku-latest"
tier_order = ["ollama", "gemini", "claude", "scoring"]
max_tokens = 2048
shadow_mode = true            # Compare AI vs scoring brain decisions

[fleet]
max_bots = 20
default_storage_mode = "faction_deposit"  # "sell", "deposit", "faction_deposit"
# home_system = ""            # Home system ID
# home_base = ""              # Home station base ID
# faction_storage_station = "" # Station for supply chain ops

[[goals]]
type = "maximize_income"
priority = 1
```

## Brain System

The commander evaluates fleet state and assigns routines using a tiered AI brain:

1. **Ollama** — Local LLM (fastest, no API cost)
2. **Gemini** — Google AI (fast, cheap)
3. **Claude** — Anthropic (highest quality)
4. **Scoring** — Deterministic fallback (always available)

Each tier falls back to the next on failure. Shadow mode runs the scoring brain in parallel to compare decisions.

## Routines

| Routine | Description |
|---------|-------------|
| `miner` | Extract ore at asteroid belts, sell at stations |
| `harvester` | Harvest gas/ice from clouds and fields |
| `trader` | Arbitrage trading between stations using market intel |
| `crafter` | Manufacture items from gathered materials |
| `quartermaster` | Manage faction treasury, buy/sell orders, tax collection |
| `explorer` | Chart unknown systems, scan POIs, map the galaxy |
| `scout` | One-shot bootstrap to find faction home base |
| `hunter` | Hunt pirates or hostile players for bounties |
| `salvager` | Salvage wrecks for components |
| `scavenger` | Loot battlefield wrecks opportunistically |
| `mission_runner` | Accept and complete NPC missions |
| `ship_upgrade` | Purchase better ships when affordable |
| `refit` | Install/swap modules and equipment |
| `return_home` | Navigate back to home station |

Routines are async generators that yield status strings, allowing the dashboard to show real-time progress.

## Dashboard

The Svelte dashboard provides real-time fleet monitoring:

- **Fleet Overview** — Bot status, credits/hr, cargo, location
- **Commander** — AI decisions, brain health, evaluation history
- **Economy** — Revenue tracking, market data, open orders, supply chain
- **Faction** — Members, storage, facilities, intel coverage
- **Manual** — Galaxy browser, game catalog (ships, items, skills, recipes)
- **Settings** — Fleet config, bot settings, goals

## Scripts

```bash
bun run dev          # Start backend (watch mode)
bun run start        # Start backend (production)
bun run dev:web      # Start dashboard dev server
bun run build:web    # Build dashboard for production
bun run test         # Run tests
bun run db:push      # Push schema changes to SQLite
bun run db:studio    # Open Drizzle Studio (DB browser)
```

## API Coverage

The API client (`src/core/api-client.ts`) covers 151 SpaceMolt endpoints including:

- Navigation (travel, jump, dock/undock)
- Mining, harvesting, crafting
- Trading (buy/sell, market orders, market analysis)
- Combat (attack, battle, scan, cloak)
- Ship management (buy, sell, commission, modules)
- Faction operations (storage, facilities, intel, diplomacy)
- Social (chat, forum, missions, gifts)

## License

Private project — not open source.
