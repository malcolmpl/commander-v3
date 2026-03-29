/**
 * Fleet-wide tunable constants.
 * Extracted from hardcoded values across routines/helpers.
 * Eventually these could move into config.toml for runtime tuning.
 */

// ── Fuel ──
export const FUEL_REFUEL_THRESHOLD = 60;        // % — refuel when below this
export const FUEL_PREDEPARTURE_THRESHOLD = 95;   // % — top off before undocking
export const FUEL_CELL_RESERVE = 3;              // emergency fuel cells to carry
export const FUEL_CELL_MAX_PRICE = 300;          // don't overpay for fuel cells
export const FUEL_SAFETY_MARGIN = 3;             // extra fuel units reserved for return
export const FUEL_LOW_BURN_THRESHOLD = 50;       // % — burn cargo cells if below

// ── Repair ──
export const REPAIR_THRESHOLD = 80;              // % hull — repair when below
export const REPAIR_SERVICE_THRESHOLD = 90;      // % hull — service-level repair
export const MODULE_REPAIR_THRESHOLD = 90;       // % durability — repair worn modules
export const EMERGENCY_HULL_THRESHOLD = 60;      // % hull — triggers emergency

// ── Insurance ──
export const INSURANCE_MAX_WALLET_PCT = 0.10;    // max % of credits to spend on premium
export const INSURANCE_DURATION_TICKS = 360;     // ~1 hour at 10s/tick

// ── Trading ──
export const MAX_MATERIAL_BUY_PRICE = 20_000;    // absolute cap on material purchases
export const INSIGHT_GATE_PRICE = 500;            // require demand insight above this
export const PRICE_UNDERCUT_PCT = 0.05;           // undercut competitors by 5%
export const BUY_BUDGET_PCT = 0.30;               // spend up to 30% of credits per buy
export const STALE_ORDER_TIMEOUT_MS = 7_200_000;  // cancel orders older than 2h

// ── Cargo ──
export const CARGO_URGENT_PCT = 0.80;             // dock to sell at 80% full
export const CARGO_FULL_PCT = 0.90;               // skip travel at 90% full

// ── Timing ──
export const STORAGE_COLLECT_INTERVAL_MS = 300_000;  // collect credits every 5min
export const MARKET_INSIGHT_STALE_MS = 1_800_000;    // re-analyze market after 30min
export const WRECK_RESET_INTERVAL_MS = 600_000;      // clear wreck memory every 10min
export const VISITED_SYSTEM_MEMORY = 15;              // remember last N visited systems

// ── Mining ──
export const MINE_REFRESH_INTERVAL = 5;           // refresh state every N mines

// ── Ship Dealer ──
export const SHIP_DEALER_MIN_MARGIN_PCT = 20;    // min profit margin to commission
export const SHIP_DEALER_LISTING_MARKUP_PCT = 30; // markup over commission cost
export const SHIP_DEALER_MAX_WALLET_PCT = 0.60;   // max fraction of wallet to spend

// ── Strategic Resources ──
// Resources critical for supply chain progression (e.g. circuit boards → tier II modules).
// When storage is below the threshold, nebula/belt scoring gets a large demand boost.
export const STRATEGIC_RESOURCES: Array<{ itemId: string; poiTypes: string[]; minStock: number; boostScore: number }> = [
  { itemId: "energy_crystal", poiTypes: ["nebula", "gas_cloud"], minStock: 500, boostScore: 800 },
  { itemId: "silicon_ore", poiTypes: ["asteroid_belt", "asteroid"], minStock: 500, boostScore: 600 },  // Critical for circuit boards
  { itemId: "phase_crystal", poiTypes: ["nebula", "gas_cloud"], minStock: 50, boostScore: 100 },
  { itemId: "focused_crystal", poiTypes: [], minStock: 20, boostScore: 200 },  // Needed for Hyper ML3, ML2
  { itemId: "circuit_board", poiTypes: [], minStock: 50, boostScore: 300 },  // Needed for ML1, filters, power cells
  { itemId: "superconductor", poiTypes: [], minStock: 20, boostScore: 200 },  // Needed for Strip Miner, filters
  { itemId: "power_core", poiTypes: [], minStock: 10, boostScore: 200 },  // Needed for ML5, Strip Miner, filters
  { itemId: "steel_plate", poiTypes: [], minStock: 100, boostScore: 100 },  // Base material for many modules
  { itemId: "flex_polymer", poiTypes: [], minStock: 50, boostScore: 100 },  // Needed for Cargo Expanders, filters
  { itemId: "titanium_alloy", poiTypes: [], minStock: 50, boostScore: 200 },  // Shipyard component — huge demand
  { itemId: "hull_plating", poiTypes: [], minStock: 30, boostScore: 150 },  // Shipyard component
  { itemId: "engine_core", poiTypes: [], minStock: 15, boostScore: 150 },  // Shipyard component
  { itemId: "sensor_array", poiTypes: [], minStock: 20, boostScore: 150 },  // Shipyard component
  { itemId: "processing_core", poiTypes: [], minStock: 10, boostScore: 150 },  // Shipyard component
  { itemId: "durasteel_plate", poiTypes: [], minStock: 20, boostScore: 150 },  // Shipyard component
];

// Known strategic resource locations — injected into galaxy on startup if not already known
export const KNOWN_RESOURCE_LOCATIONS: Array<{ systemId: string; poiId: string; poiName: string; poiType: string; resources: Array<{ resourceId: string; richness: number }> }> = [
  {
    systemId: "frontier",
    poiId: "veil_nebula",
    poiName: "Veil Nebula",
    poiType: "nebula",
    resources: [
      { resourceId: "energy_crystal", richness: 40 },
      { resourceId: "quantum_fragments", richness: 25 },
      { resourceId: "phase_crystal", richness: 18 },
    ],
  },
  {
    systemId: "haven",
    poiId: "commerce_fields",
    poiName: "Commerce Fields",
    poiType: "asteroid_belt",
    resources: [
      { resourceId: "silicon_ore", richness: 70 },
      { resourceId: "iron_ore", richness: 75 },
      { resourceId: "copper_ore", richness: 65 },
      { resourceId: "nickel_ore", richness: 55 },
    ],
  },
];
