/**
 * Hardcoded resource location data — discovered asteroid belt compositions.
 * Updated by manual exploration. Prevents re-exploring known systems.
 *
 * Format: { system_id: { poi_id: { name, resources: { resource_id: { richness, remaining } } } } }
 */

export interface BeltResource {
  richness: number;
  remaining: number;
  maxRemaining: number;
}

export interface BeltData {
  name: string;
  type: "asteroid_belt" | "ice_field" | "gas_cloud";
  resources: Record<string, BeltResource>;
  /** When this data was last verified */
  lastVerified: string;
}

export interface SystemBelts {
  /** POI ID → belt data */
  [poiId: string]: BeltData;
}

/**
 * Known resource deposits across the galaxy.
 * Key = system_id, value = map of POI belts in that system.
 */
export const KNOWN_RESOURCE_LOCATIONS: Record<string, SystemBelts> = {
  // ── Solarian Core ──
  sol: {
    main_belt: {
      name: "Main Belt",
      type: "asteroid_belt",
      resources: {
        iron_ore: { richness: 50, remaining: 0, maxRemaining: 100000 }, // DEPLETED as of 2026-03-19
        nickel_ore: { richness: 30, remaining: 100000, maxRemaining: 100000 },
        copper_ore: { richness: 25, remaining: 100000, maxRemaining: 100000 },
        titanium_ore: { richness: 8, remaining: 5000, maxRemaining: 5000 },
        sol_alloy_ore: { richness: 5, remaining: 1000, maxRemaining: 1000 },
      },
      lastVerified: "2026-03-19",
    },
  },

  // ── Solarian Frontier ──
  electra: {
    old_earth_scatter_electra: {
      name: "Old Earth Scatter — Electra",
      type: "asteroid_belt",
      resources: {
        iron_ore: { richness: 35, remaining: 100000, maxRemaining: 100000 },
        copper_ore: { richness: 20, remaining: 100000, maxRemaining: 100000 },
        sol_alloy_ore: { richness: 7, remaining: 2224, maxRemaining: 2224 },
      },
      lastVerified: "2026-03-20",
    },
  },

  mimosa: {
    unstable_pocket_mimosa: {
      name: "Unstable Pocket — Mimosa",
      type: "asteroid_belt",
      resources: {
        iron_ore: { richness: 42, remaining: 100000, maxRemaining: 100000 },
        copper_ore: { richness: 33, remaining: 100000, maxRemaining: 100000 },
        antimatter_containment_cell: { richness: 3, remaining: 271, maxRemaining: 271 },
      },
      lastVerified: "2026-03-20",
    },
  },

  keelbreak: {
    uncut_gems_keelbreak: {
      name: "Uncut Gems — Keelbreak",
      type: "asteroid_belt",
      resources: {
        iron_ore: { richness: 45, remaining: 100000, maxRemaining: 100000 },
        copper_ore: { richness: 24, remaining: 100000, maxRemaining: 100000 },
        trade_crystal: { richness: 18, remaining: 2400, maxRemaining: 2400 },
      },
      lastVerified: "2026-03-20",
    },
  },

  miaplacidus: {
    miaplacidus_alloy_remnants: {
      name: "Miaplacidus Alloy Remnants",
      type: "asteroid_belt",
      resources: {
        iron_ore: { richness: 39, remaining: 100000, maxRemaining: 100000 },
        copper_ore: { richness: 29, remaining: 100000, maxRemaining: 100000 },
        sol_alloy_ore: { richness: 5, remaining: 1642, maxRemaining: 1642 },
      },
      lastVerified: "2026-03-20",
    },
  },
  // ── Nebula Core ──
  haven: {
    commerce_fields: {
      name: "Commerce Fields",
      type: "asteroid_belt",
      resources: {
        iron_ore: { richness: 75, remaining: 22, maxRemaining: 100000 },
        copper_ore: { richness: 65, remaining: 19, maxRemaining: 100000 },
        nickel_ore: { richness: 55, remaining: 16, maxRemaining: 20000 },
        silicon_ore: { richness: 70, remaining: 21, maxRemaining: 20000 }, // *** SILICON HERE ***
        trade_crystal: { richness: 20, remaining: 6, maxRemaining: 40000 },
      },
      lastVerified: "2026-03-20",
    },
  },

  // ── Nebula Frontier ──
  gold_run: {
    gold_run_mineral_fields: {
      name: "Gold Run Mineral Fields",
      type: "asteroid_belt",
      resources: {
        carbon_ore: { richness: 48, remaining: 8, maxRemaining: 30000 },
        vanadium_ore: { richness: 46, remaining: 3, maxRemaining: 25000 },
        palladium_ore: { richness: 30, remaining: 11, maxRemaining: 5000 },
        gold_ore: { richness: 25, remaining: 7, maxRemaining: 8000 },
      },
      lastVerified: "2026-03-20",
    },
  },

  khambalia: {
    khambalia_belt: {
      name: "Khambalia Belt",
      type: "asteroid_belt",
      resources: {
        carbon_ore: { richness: 47, remaining: 30000, maxRemaining: 30000 },
        vanadium_ore: { richness: 34, remaining: 25000, maxRemaining: 25000 },
        platinum_ore: { richness: 28, remaining: 25000, maxRemaining: 25000 },
        uranium_ore: { richness: 16, remaining: 5000, maxRemaining: 5000 },
        lead_ore: { richness: 13, remaining: 10000, maxRemaining: 10000 },
        radium_ore: { richness: 7, remaining: 2000, maxRemaining: 2000 },
        gold_ore: { richness: 32, remaining: 25000, maxRemaining: 25000 },
      },
      lastVerified: "2026-03-20",
    },
    khambalia_crystal_market: {
      name: "Khambalia Crystal Market",
      type: "asteroid_belt",
      resources: {
        iron_ore: { richness: 36, remaining: 63697, maxRemaining: 100000 },
        copper_ore: { richness: 35, remaining: 65479, maxRemaining: 100000 },
        trade_crystal: { richness: 30, remaining: 10, maxRemaining: 4000 },
      },
      lastVerified: "2026-03-20",
    },
  },
};

// ── Systems confirmed to have NO asteroid belts ──
export const SYSTEMS_WITHOUT_BELTS: string[] = [
  "alpha_centauri", // ice field only
  "tau_ceti",       // planets only
  "maplevale",      // gas cloud only
  "dubhe",          // planets only
  "alfirk",         // planets only
  "revati",         // planets only
  "zibal",          // ice field only
  "copernicus",     // gas cloud only
  "market_prime",   // trade hub, gas cloud only
  "traders_rest",   // resort station only
  "factory_belt",   // manufacturing hub, gas cloud only
];

// ── Resource Index (built once, O(1) lookups) ──

interface ResourceEntry {
  systemId: string;
  poiId: string;
  beltName: string;
  beltType: "asteroid_belt" | "ice_field" | "gas_cloud";
  richness: number;
  remaining: number;
}

/** Pre-built index: resourceId → sorted entries (by richness desc) */
let _resourceIndex: Map<string, ResourceEntry[]> | null = null;
let _exploredSet: Set<string> | null = null;

function getResourceIndex(): Map<string, ResourceEntry[]> {
  if (_resourceIndex) return _resourceIndex;
  _resourceIndex = new Map();
  for (const [systemId, belts] of Object.entries(KNOWN_RESOURCE_LOCATIONS)) {
    for (const [poiId, belt] of Object.entries(belts)) {
      for (const [resourceId, res] of Object.entries(belt.resources)) {
        if (!_resourceIndex.has(resourceId)) _resourceIndex.set(resourceId, []);
        _resourceIndex.get(resourceId)!.push({
          systemId,
          poiId,
          beltName: belt.name,
          beltType: belt.type,
          richness: res.richness,
          remaining: res.remaining,
        });
      }
    }
  }
  // Sort each resource's entries by richness descending
  for (const entries of _resourceIndex.values()) {
    entries.sort((a, b) => b.richness - a.richness);
  }
  return _resourceIndex;
}

function getExploredSet(): Set<string> {
  if (_exploredSet) return _exploredSet;
  _exploredSet = new Set([
    ...Object.keys(KNOWN_RESOURCE_LOCATIONS),
    ...SYSTEMS_WITHOUT_BELTS,
  ]);
  return _exploredSet;
}

/** Invalidate cached index (call after updating KNOWN_RESOURCE_LOCATIONS) */
export function invalidateResourceIndex(): void {
  _resourceIndex = null;
  _exploredSet = null;
}

// ── Resource search helpers ──

/** Find all known belts containing a specific resource (O(1) lookup + filter) */
export function findResourceBelts(resourceId: string): Array<{
  systemId: string;
  poiId: string;
  beltName: string;
  richness: number;
  remaining: number;
}> {
  const index = getResourceIndex();
  const entries = index.get(resourceId);
  if (!entries) return [];
  return entries
    .filter(e => e.remaining > 0)
    .map(e => ({
      systemId: e.systemId,
      poiId: e.poiId,
      beltName: e.beltName,
      richness: e.richness,
      remaining: e.remaining,
    }));
}

/** Get all known resource IDs (O(1)) */
export function getAllKnownResources(): string[] {
  return [...getResourceIndex().keys()];
}

/** Find systems with a specific resource, optionally filtered by belt type */
export function findSystemsWithResource(
  resourceId: string,
  beltType?: "asteroid_belt" | "ice_field" | "gas_cloud"
): string[] {
  const index = getResourceIndex();
  const entries = index.get(resourceId);
  if (!entries) return [];
  const systems = new Set<string>();
  for (const e of entries) {
    if (e.remaining <= 0) continue;
    if (beltType && e.beltType !== beltType) continue;
    systems.add(e.systemId);
  }
  return [...systems];
}

/** Check if a system has been explored for resources (O(1)) */
export function isSystemExplored(systemId: string): boolean {
  return getExploredSet().has(systemId);
}
