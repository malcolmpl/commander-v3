<script lang="ts">
	import { send, catalogData, connectionState, bots, galaxyDetail, type CatalogData, type GalaxyDetailData } from "$stores/websocket";

	type Tab = "galaxy" | "ships" | "modules" | "skills" | "recipes";
	let activeTab = $state<Tab>("galaxy");
	let search = $state("");
	let shipSort = $state<"name" | "price" | "cargo" | "hull" | "speed">("name");
	let shipSortDir = $state<"asc" | "desc">("asc");
	let shipRegion = $state("all");
	let shipCommission = $state("all");
	let skillCategory = $state("all");
	let itemCategory = $state("all");
	let galaxyEmpire = $state("all");
	let galaxySearch = $state("");
	let expandedSystem = $state<string | null>(null);
	let expandedPoi = $state<string | null>(null);
	let expandedShip = $state<string | null>(null);
	let expandedSkill = $state<string | null>(null);
	let expandedRecipe = $state<string | null>(null);
	let requested = $state(false);
	let galaxyRequested = $state(false);

	// Request catalog + galaxy when connected (handles initial load + reconnects)
	$effect(() => {
		if ($connectionState === "connected" && !$catalogData && !requested) {
			requested = true;
			setTimeout(() => send({ type: "request_catalog" }), 500);
		}
		if ($catalogData) requested = false;
	});

	$effect(() => {
		if ($connectionState === "connected" && !$galaxyDetail && !galaxyRequested) {
			galaxyRequested = true;
			setTimeout(() => send({ type: "request_galaxy_detail" }), 600);
		}
		if ($galaxyDetail) galaxyRequested = false;
	});

	function reload() {
		catalogData.set(null);
		send({ type: "request_catalog" });
	}

	const tabs: { id: Tab; label: string }[] = [
		{ id: "galaxy", label: "Galaxy" },
		{ id: "ships", label: "Ships" },
		{ id: "modules", label: "Modules & Items" },
		{ id: "skills", label: "Skills" },
		{ id: "recipes", label: "Recipes" },
	];

	// ── Ships ──
	// ── Galaxy ──
	function getGalaxyEmpires(data: GalaxyDetailData): string[] {
		return [...new Set(data.systems.map(s => s.empire).filter(Boolean))].sort();
	}

	function getFilteredSystems(data: GalaxyDetailData) {
		let systems = [...data.systems];
		const q = galaxySearch.toLowerCase();
		if (q) systems = systems.filter(s =>
			s.name.toLowerCase().includes(q) ||
			s.id.toLowerCase().includes(q) ||
			s.empire.toLowerCase().includes(q) ||
			s.pois.some(p => p.name.toLowerCase().includes(q) || p.type.toLowerCase().includes(q) || (p.baseName ?? "").toLowerCase().includes(q))
		);
		if (galaxyEmpire !== "all") systems = systems.filter(s => s.empire === galaxyEmpire);
		// Sort: systems with our bots first, then by name
		const botSystemIds = new Set(($bots ?? []).filter(b => b.systemId).map(b => b.systemId));
		systems.sort((a, b) => {
			const aHasBot = botSystemIds.has(a.id) ? 0 : 1;
			const bHasBot = botSystemIds.has(b.id) ? 0 : 1;
			if (aHasBot !== bHasBot) return aHasBot - bHasBot;
			return a.name.localeCompare(b.name);
		});
		return systems;
	}

	function getBotsInSystem(systemId: string) {
		return ($bots ?? []).filter(b => b.systemId === systemId);
	}

	function getBotsAtPoi(poiId: string) {
		return ($bots ?? []).filter(b => b.poiId === poiId);
	}

	function freshnessDot(baseId: string | null, baseMarket: GalaxyDetailData["baseMarket"]): { color: string; label: string } {
		if (!baseId || !baseMarket[baseId]) return { color: "bg-hull-grey", label: "No data" };
		const f = baseMarket[baseId].freshness;
		const ageMin = f.ageMs / 60_000;
		if (ageMin < 5) return { color: "bg-bio-green", label: `Fresh (${Math.round(ageMin)}m ago)` };
		if (ageMin < 15) return { color: "bg-warning-yellow", label: `Stale (${Math.round(ageMin)}m ago)` };
		return { color: "bg-claw-red", label: `Old (${Math.round(ageMin)}m ago)` };
	}

	function resourceFreshness(scannedAt: number): { color: string; label: string } {
		if (!scannedAt) return { color: "bg-hull-grey", label: "Never scanned" };
		const ageMin = (Date.now() - scannedAt) / 60_000;
		if (ageMin < 10) return { color: "bg-bio-green", label: `Scanned ${Math.round(ageMin)}m ago` };
		if (ageMin < 30) return { color: "bg-warning-yellow", label: `Scanned ${Math.round(ageMin)}m ago` };
		return { color: "bg-claw-red", label: `Scanned ${Math.round(ageMin)}m ago` };
	}

	const RESOURCE_TYPES: Record<string, string> = {
		asteroid_belt: "Ore", ice_field: "Ice", gas_cloud: "Gas",
	};

	function isMinablePoi(type: string): boolean {
		return type === "asteroid_belt" || type === "ice_field" || type === "gas_cloud" || type === "nebula";
	}

	function getShipRegions(data: CatalogData): string[] {
		return [...new Set(data.ships.map(s => s.region || "").filter(Boolean))].sort();
	}

	function getShips(data: CatalogData) {
		let ships = [...data.ships];
		const q = search.toLowerCase();
		if (q) ships = ships.filter(s => s.name.toLowerCase().includes(q) || s.category.toLowerCase().includes(q) || s.id.toLowerCase().includes(q) || (s.region ?? "").toLowerCase().includes(q));
		if (shipRegion !== "all") ships = ships.filter(s => (s.region || "") === shipRegion);
		if (shipCommission === "yes") ships = ships.filter(s => s.commissionable);
		else if (shipCommission === "no") ships = ships.filter(s => !s.commissionable);
		ships.sort((a, b) => {
			let cmp = 0;
			switch (shipSort) {
				case "name": cmp = a.name.localeCompare(b.name); break;
				case "price": cmp = a.basePrice - b.basePrice; break;
				case "cargo": cmp = a.cargoCapacity - b.cargoCapacity; break;
				case "hull": cmp = a.hull - b.hull; break;
				case "speed": cmp = a.speed - b.speed; break;
			}
			return shipSortDir === "asc" ? cmp : -cmp;
		});
		return ships;
	}

	function toggleShipSort(col: typeof shipSort) {
		if (shipSort === col) shipSortDir = shipSortDir === "asc" ? "desc" : "asc";
		else { shipSort = col; shipSortDir = col === "name" ? "asc" : "desc"; }
	}

	function shipRoleFit(ship: CatalogData["ships"][0]): string {
		const roles: string[] = [];
		if (ship.cargoCapacity >= 200) roles.push("Trader");
		if (ship.cargoCapacity >= 100) roles.push("Miner");
		if (ship.hull >= 500 || ship.shield >= 200) roles.push("Hunter");
		if (ship.speed >= 8) roles.push("Explorer");
		if (ship.cpuCapacity >= 6) roles.push("Crafter");
		return roles.length > 0 ? roles.join(", ") : "General";
	}

	// ── Items/Modules ──
	function getItems(data: CatalogData) {
		let items = [...data.items];
		const q = search.toLowerCase();
		if (q) items = items.filter(i => i.name.toLowerCase().includes(q) || i.id.toLowerCase().includes(q) || i.category.toLowerCase().includes(q));
		if (itemCategory !== "all") items = items.filter(i => i.category === itemCategory);
		items.sort((a, b) => a.name.localeCompare(b.name));
		return items;
	}

	function getItemCategories(data: CatalogData): string[] {
		return [...new Set(data.items.map(i => i.category))].sort();
	}

	function isModule(item: CatalogData["items"][0]): boolean {
		return item.category === "module" || item.id.includes("_laser") || item.id.includes("_scanner") || item.id.includes("_harvester") || item.id.includes("shield_") || item.id.includes("armor_");
	}

	// ── Skills ──
	function getSkills(data: CatalogData) {
		let skills = [...data.skills];
		const q = search.toLowerCase();
		if (q) skills = skills.filter(s => s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q) || s.category.toLowerCase().includes(q));
		if (skillCategory !== "all") skills = skills.filter(s => s.category === skillCategory);
		skills.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
		return skills;
	}

	function getSkillCategories(data: CatalogData): string[] {
		return [...new Set(data.skills.map(s => s.category))].sort();
	}

	// ── Recipes ──
	function getRecipes(data: CatalogData) {
		let recipes = [...data.recipes];
		const q = search.toLowerCase();
		if (q) recipes = recipes.filter(r => r.name.toLowerCase().includes(q) || r.outputItem.toLowerCase().includes(q) || r.id.toLowerCase().includes(q));
		recipes.sort((a, b) => a.name.localeCompare(b.name));
		return recipes;
	}

	function resolveItemName(data: CatalogData, itemId: string): string {
		return data.items.find(i => i.id === itemId)?.name ?? itemId;
	}

	function formatNum(n: number): string {
		return n.toLocaleString();
	}

	const sortArrow = (col: string, cur: string, dir: string) =>
		col === cur ? (dir === "asc" ? " ^" : " v") : "";
</script>

<div class="space-y-4">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<h1 class="text-xl font-bold text-star-white">Game Manual</h1>
		<button
			class="px-3 py-1.5 text-xs font-medium rounded bg-nebula-blue text-plasma-cyan hover:bg-nebula-blue/80 transition-colors"
			onclick={reload}
		>
			Refresh Catalog
		</button>
	</div>

	<!-- Tabs -->
	<div class="flex gap-1 border-b border-hull-grey/30 pb-1">
		{#each tabs as tab}
			<button
				class="px-4 py-2 text-sm font-medium rounded-t transition-colors {activeTab === tab.id
					? 'bg-nebula-blue text-plasma-cyan border-b-2 border-plasma-cyan'
					: 'text-chrome-silver hover:text-star-white hover:bg-nebula-blue/30'}"
				onclick={() => { activeTab = tab.id; search = ""; }}
			>
				{tab.label}
				{#if tab.id === "galaxy" && $galaxyDetail}
					<span class="ml-1 text-xs text-hull-grey">({$galaxyDetail.systems.length})</span>
				{:else if tab.id !== "galaxy" && $catalogData}
					<span class="ml-1 text-xs text-hull-grey">
						({tab.id === "ships" ? $catalogData.ships.length
						: tab.id === "modules" ? $catalogData.items.length
						: tab.id === "skills" ? $catalogData.skills.length
						: $catalogData.recipes.length})
					</span>
				{/if}
			</button>
		{/each}
	</div>

	<!-- Search bar -->
	<div class="flex items-center gap-3">
		{#if activeTab === "galaxy"}
			<input
				type="text"
				placeholder="Search systems, POIs, bases..."
				bind:value={galaxySearch}
				class="flex-1 px-3 py-2 bg-nebula-blue/30 border border-hull-grey/30 rounded text-sm text-star-white placeholder:text-hull-grey focus:outline-none focus:border-plasma-cyan/50"
			/>
			{#if $galaxyDetail}
				<select
					bind:value={galaxyEmpire}
					class="px-2 py-2 bg-nebula-blue/30 border border-hull-grey/30 rounded text-sm text-star-white"
				>
					<option value="all">All Empires</option>
					{#each getGalaxyEmpires($galaxyDetail) as emp}
						<option value={emp}>{emp}</option>
					{/each}
				</select>
			{/if}
			<button
				class="px-3 py-2 text-xs font-medium rounded bg-nebula-blue text-plasma-cyan hover:bg-nebula-blue/80 transition-colors whitespace-nowrap"
				onclick={() => { galaxyDetail.set(null); send({ type: "request_galaxy_detail" }); }}
			>
				Refresh
			</button>
		{:else}
			<input
				type="text"
				placeholder="Search {activeTab}..."
				bind:value={search}
				class="flex-1 px-3 py-2 bg-nebula-blue/30 border border-hull-grey/30 rounded text-sm text-star-white placeholder:text-hull-grey focus:outline-none focus:border-plasma-cyan/50"
			/>
		{/if}
		{#if activeTab === "ships" && $catalogData}
			<select
				bind:value={shipRegion}
				class="px-2 py-2 bg-nebula-blue/30 border border-hull-grey/30 rounded text-sm text-star-white"
			>
				<option value="all">All Regions</option>
				{#each getShipRegions($catalogData) as region}
					<option value={region}>{region}</option>
				{/each}
			</select>
			<select
				bind:value={shipCommission}
				class="px-2 py-2 bg-nebula-blue/30 border border-hull-grey/30 rounded text-sm text-star-white"
			>
				<option value="all">All Availability</option>
				<option value="yes">Commissionable</option>
				<option value="no">Not Commissionable</option>
			</select>
		{/if}
		{#if activeTab === "skills" && $catalogData}
			<select
				bind:value={skillCategory}
				class="px-2 py-2 bg-nebula-blue/30 border border-hull-grey/30 rounded text-sm text-star-white"
			>
				<option value="all">All Categories</option>
				{#each getSkillCategories($catalogData) as cat}
					<option value={cat}>{cat}</option>
				{/each}
			</select>
		{/if}
		{#if activeTab === "modules" && $catalogData}
			<select
				bind:value={itemCategory}
				class="px-2 py-2 bg-nebula-blue/30 border border-hull-grey/30 rounded text-sm text-star-white"
			>
				<option value="all">All Categories</option>
				{#each getItemCategories($catalogData) as cat}
					<option value={cat}>{cat}</option>
				{/each}
			</select>
		{/if}
	</div>

	<!-- ════════ GALAXY ════════ -->
	{#if activeTab === "galaxy"}
		{#if !$galaxyDetail}
			<div class="text-center py-16 text-hull-grey">
				<p class="text-lg">Loading galaxy data...</p>
				<p class="text-sm mt-2">Make sure at least one bot is logged in.</p>
			</div>
		{:else}
			{@const systems = getFilteredSystems($galaxyDetail)}
			<!-- Legend -->
			<div class="flex items-center gap-4 text-xs text-hull-grey mb-2">
				<span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-bio-green inline-block"></span> Fresh (&lt;5m)</span>
				<span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-warning-yellow inline-block"></span> Stale (5-15m)</span>
				<span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-claw-red inline-block"></span> Old (&gt;15m)</span>
				<span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-hull-grey inline-block"></span> No data</span>
				<span class="ml-auto text-chrome-silver">{systems.length} systems</span>
			</div>

			<div class="space-y-2">
				{#each systems as sys (sys.id)}
					{@const sysBots = getBotsInSystem(sys.id)}
					{@const isExpanded = expandedSystem === sys.id}
					<div class="border border-hull-grey/20 rounded overflow-hidden">
						<!-- System header -->
						<button
							class="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-nebula-blue/15 transition-colors text-left"
							onclick={() => expandedSystem = isExpanded ? null : sys.id}
						>
							<span class="text-star-white font-medium text-sm">{sys.name}</span>
							<span class="text-[10px] px-1.5 py-0.5 rounded bg-nebula-blue text-chrome-silver capitalize">{sys.empire || "neutral"}</span>
							{#if sys.policeLevel > 0}
								<span class="text-[10px] px-1.5 py-0.5 rounded bg-bio-green/20 text-bio-green">Police {sys.policeLevel}</span>
							{/if}
							<span class="text-xs text-hull-grey">{sys.poiCount} POIs</span>
							{#if sysBots.length > 0}
								<span class="text-[10px] px-1.5 py-0.5 rounded bg-plasma-cyan/20 text-plasma-cyan">{sysBots.length} bot{sysBots.length > 1 ? "s" : ""}</span>
							{/if}
							<!-- Freshness dots for bases in this system -->
							{#each sys.pois.filter(p => p.hasBase) as basePoi}
								{@const dot = freshnessDot(basePoi.baseId, $galaxyDetail.baseMarket)}
								<span class="w-2 h-2 rounded-full {dot.color} inline-block" title="{basePoi.baseName ?? basePoi.name}: {dot.label}"></span>
							{/each}
							<span class="ml-auto text-hull-grey text-xs">{isExpanded ? "▲" : "▼"}</span>
						</button>

						{#if isExpanded}
							<!-- Bots in system -->
							{#if sysBots.length > 0}
								<div class="px-4 py-2 border-t border-hull-grey/10 bg-nebula-blue/5">
									<div class="text-xs text-hull-grey mb-1">Bots in System</div>
									<div class="flex flex-wrap gap-2">
										{#each sysBots as bot}
											<span class="text-xs px-2 py-1 rounded bg-plasma-cyan/15 text-plasma-cyan">
												{bot.username}
												{#if bot.routine}<span class="text-hull-grey ml-1">({bot.routine})</span>{/if}
												{#if bot.poiName}<span class="text-chrome-silver ml-1">@ {bot.poiName}</span>{/if}
												{#if bot.docked}<span class="text-bio-green ml-1">docked</span>{/if}
											</span>
										{/each}
									</div>
								</div>
							{/if}

							<!-- POIs -->
							<div class="px-4 py-2 border-t border-hull-grey/10">
								<div class="text-xs text-hull-grey mb-2">Points of Interest</div>
								{#if sys.pois.length === 0}
									<p class="text-xs text-hull-grey italic">{sys.visited ? "No POIs discovered" : "System not yet explored"}</p>
								{:else}
									<div class="space-y-1.5">
										{#each sys.pois as poi (poi.id)}
											{@const poiBots = getBotsAtPoi(poi.id)}
											{@const dot = freshnessDot(poi.baseId, $galaxyDetail.baseMarket)}
											{@const marketData = poi.baseId ? $galaxyDetail.baseMarket[poi.baseId] : null}
											{@const isPoiExpanded = expandedPoi === poi.id}
											<div class="border border-hull-grey/10 rounded">
												<button
													class="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-nebula-blue/10 transition-colors"
													onclick={() => expandedPoi = isPoiExpanded ? null : poi.id}
												>
													{#if poi.hasBase}
														<span class="w-2 h-2 rounded-full {dot.color}" title={dot.label}></span>
													{:else if isMinablePoi(poi.type)}
														{@const resDot = resourceFreshness(poi.scannedAt)}
														<span class="w-2 h-2 rounded-full {resDot.color}" title={resDot.label}></span>
													{/if}
													<span class="text-star-white text-xs font-medium">{poi.name}</span>
													<span class="text-[10px] px-1 py-0.5 rounded bg-hull-grey/20 text-hull-grey capitalize">{poi.type.replace(/_/g, " ")}</span>
													{#if isMinablePoi(poi.type)}
														<span class="text-[10px] px-1 py-0.5 rounded bg-bio-green/20 text-bio-green">{RESOURCE_TYPES[poi.type] ?? "Resource"}</span>
													{/if}
													{#if poi.hasBase && poi.baseName}
														<span class="text-[10px] text-warning-yellow">Base: {poi.baseName}</span>
													{/if}
													{#if poiBots.length > 0}
														<span class="text-[10px] px-1 py-0.5 rounded bg-plasma-cyan/15 text-plasma-cyan">{poiBots.length} bot{poiBots.length > 1 ? "s" : ""}</span>
													{/if}
													{#if marketData}
														<span class="text-[10px] text-chrome-silver">{marketData.prices.length} items</span>
													{/if}
													{#if poi.resources.length > 0}
														<span class="text-[10px] text-bio-green">{poi.resources.length} ore{poi.resources.length > 1 ? "s" : ""}</span>
													{/if}
													<span class="ml-auto text-hull-grey text-[10px]">{isPoiExpanded ? "▲" : "▼"}</span>
												</button>

												{#if isPoiExpanded}
													<div class="px-3 py-2 border-t border-hull-grey/10 space-y-2">
														<!-- Resources (ore/ice/gas) -->
														{#if poi.resources.length > 0 || isMinablePoi(poi.type)}
															{@const resDot = resourceFreshness(poi.scannedAt)}
															<div>
																<div class="flex items-center gap-2 mb-1">
																	<span class="text-[10px] text-hull-grey">Minable Resources</span>
																	<span class="w-2 h-2 rounded-full {resDot.color}" title={resDot.label}></span>
																	<span class="text-[10px] text-hull-grey">{resDot.label}</span>
																</div>
																{#if poi.resources.length > 0}
																	<div class="grid gap-1">
																		{#each poi.resources as res}
																			<div class="flex items-center gap-3 text-xs px-2 py-1 rounded bg-bio-green/5">
																				<span class="text-bio-green font-medium w-40">{res.resourceId.replace(/_/g, " ")}</span>
																				<span class="text-hull-grey">Richness:</span>
																				<span class="text-star-white mono">{res.richness}</span>
																				{#if res.remaining > 0}
																					<span class="text-hull-grey">Remaining:</span>
																					<span class="mono {res.remaining > 100 ? 'text-bio-green' : res.remaining > 20 ? 'text-warning-yellow' : 'text-claw-red'}">{formatNum(res.remaining)}</span>
																				{:else if res.remaining === 0}
																					<span class="text-claw-red">Depleted</span>
																				{/if}
																			</div>
																		{/each}
																	</div>
																{:else}
																	<p class="text-xs text-hull-grey italic">No resources discovered yet — send an explorer or miner</p>
																{/if}
															</div>
														{/if}

														<!-- Market data -->
														{#if marketData}
															<div>
																<div class="flex items-center gap-2 mb-1">
																	<span class="text-[10px] text-hull-grey">Market Prices</span>
																	<span class="w-2 h-2 rounded-full {dot.color}" title={dot.label}></span>
																	<span class="text-[10px] text-hull-grey">{dot.label}</span>
																</div>
																<div class="overflow-x-auto">
																	<table class="w-full text-xs">
																		<thead>
																			<tr class="text-hull-grey border-b border-hull-grey/20">
																				<th class="text-left px-2 py-1">Item</th>
																				<th class="text-right px-2 py-1">Buy</th>
																				<th class="text-right px-2 py-1">Vol</th>
																				<th class="text-right px-2 py-1">Sell</th>
																				<th class="text-right px-2 py-1">Vol</th>
																			</tr>
																		</thead>
																		<tbody>
																			{#each marketData.prices.slice(0, 20) as p}
																				<tr class="border-b border-hull-grey/5 hover:bg-nebula-blue/10">
																					<td class="px-2 py-0.5 text-star-white">{p.itemName}</td>
																					<td class="px-2 py-0.5 text-right mono text-bio-green">{p.buyPrice > 0 ? formatNum(p.buyPrice) : "—"}</td>
																					<td class="px-2 py-0.5 text-right mono text-hull-grey">{p.buyVolume > 0 ? formatNum(p.buyVolume) : "—"}</td>
																					<td class="px-2 py-0.5 text-right mono text-warning-yellow">{p.sellPrice > 0 ? formatNum(p.sellPrice) : "—"}</td>
																					<td class="px-2 py-0.5 text-right mono text-hull-grey">{p.sellVolume > 0 ? formatNum(p.sellVolume) : "—"}</td>
																				</tr>
																			{/each}
																		</tbody>
																	</table>
																	{#if marketData.prices.length > 20}
																		<p class="text-[10px] text-hull-grey mt-1">...and {marketData.prices.length - 20} more items</p>
																	{/if}
																</div>
															</div>
														{:else if poi.hasBase}
															<p class="text-xs text-hull-grey italic">No market data — dock a bot here to scan prices</p>
														{/if}

														<div class="text-[10px] text-hull-grey mono">ID: {poi.id}</div>
													</div>
												{/if}
											</div>
										{/each}
									</div>
								{/if}
							</div>

							<!-- System connections -->
							{#if sys.connections.length > 0}
								<div class="px-4 py-2 border-t border-hull-grey/10">
									<div class="text-xs text-hull-grey mb-1">Connected Systems</div>
									<div class="flex flex-wrap gap-1.5">
										{#each sys.connections as conn}
											{@const connSys = $galaxyDetail.systems.find(s => s.id === conn)}
											<button
												class="text-[10px] px-1.5 py-0.5 rounded bg-nebula-blue/30 text-plasma-cyan hover:bg-nebula-blue/50 transition-colors"
												onclick={() => { expandedSystem = conn; expandedPoi = null; }}
											>
												{connSys?.name ?? conn}
											</button>
										{/each}
									</div>
								</div>
							{/if}

							<div class="px-4 py-1 border-t border-hull-grey/10 text-[10px] text-hull-grey mono">
								ID: {sys.id} | Coords: ({sys.x.toFixed(0)}, {sys.y.toFixed(0)}) | {sys.visited ? "Explored" : "Unexplored"}
							</div>
						{/if}
					</div>
				{/each}
				{#if systems.length === 0}
					<p class="text-center text-hull-grey py-8">No systems match your search.</p>
				{/if}
			</div>
		{/if}

	{:else if !$catalogData}
		<div class="text-center py-16 text-hull-grey">
			<p class="text-lg">Loading catalog data...</p>
			<p class="text-sm mt-2">Make sure at least one bot is logged in.</p>
		</div>
	{:else}
		<!-- ════════ SHIPS ════════ -->
		{#if activeTab === "ships"}
			<div class="overflow-x-auto">
				<table class="w-full text-sm">
					<thead>
						<tr class="border-b border-hull-grey/30 text-left">
							<th class="px-3 py-2 text-chrome-silver cursor-pointer hover:text-star-white" onclick={() => toggleShipSort("name")}>
								Name{sortArrow("name", shipSort, shipSortDir)}
							</th>
							<th class="px-3 py-2 text-chrome-silver">Category</th>
							<th class="px-3 py-2 text-chrome-silver cursor-pointer hover:text-star-white text-right" onclick={() => toggleShipSort("price")}>
								Price{sortArrow("price", shipSort, shipSortDir)}
							</th>
							<th class="px-3 py-2 text-chrome-silver cursor-pointer hover:text-star-white text-right" onclick={() => toggleShipSort("hull")}>
								Hull{sortArrow("hull", shipSort, shipSortDir)}
							</th>
							<th class="px-3 py-2 text-chrome-silver text-right">Shield</th>
							<th class="px-3 py-2 text-chrome-silver text-right">Armor</th>
							<th class="px-3 py-2 text-chrome-silver cursor-pointer hover:text-star-white text-right" onclick={() => toggleShipSort("speed")}>
								Speed{sortArrow("speed", shipSort, shipSortDir)}
							</th>
							<th class="px-3 py-2 text-chrome-silver text-right">Fuel</th>
							<th class="px-3 py-2 text-chrome-silver cursor-pointer hover:text-star-white text-right" onclick={() => toggleShipSort("cargo")}>
								Cargo{sortArrow("cargo", shipSort, shipSortDir)}
							</th>
							<th class="px-3 py-2 text-chrome-silver text-right">CPU</th>
							<th class="px-3 py-2 text-chrome-silver text-right">Power</th>
							<th class="px-3 py-2 text-chrome-silver">Region</th>
							<th class="px-3 py-2 text-chrome-silver">Commission</th>
							<th class="px-3 py-2 text-chrome-silver">Best For</th>
						</tr>
					</thead>
					<tbody>
						{#each getShips($catalogData) as ship (ship.id)}
							<tr
								class="border-b border-hull-grey/10 hover:bg-nebula-blue/20 cursor-pointer transition-colors"
								onclick={() => expandedShip = expandedShip === ship.id ? null : ship.id}
							>
								<td class="px-3 py-2 text-star-white font-medium">{ship.name}</td>
								<td class="px-3 py-2 text-chrome-silver capitalize">{ship.category}</td>
								<td class="px-3 py-2 text-warning-yellow text-right mono">{formatNum(ship.basePrice)}</td>
								<td class="px-3 py-2 text-right mono">{formatNum(ship.hull)}</td>
								<td class="px-3 py-2 text-right mono text-laser-blue">{formatNum(ship.shield)}</td>
								<td class="px-3 py-2 text-right mono text-chrome-silver">{formatNum(ship.armor)}</td>
								<td class="px-3 py-2 text-right mono">{ship.speed}</td>
								<td class="px-3 py-2 text-right mono">{formatNum(ship.fuel)}</td>
								<td class="px-3 py-2 text-right mono text-bio-green">{formatNum(ship.cargoCapacity)}</td>
								<td class="px-3 py-2 text-right mono">{ship.cpuCapacity}</td>
								<td class="px-3 py-2 text-right mono">{ship.powerCapacity}</td>
								<td class="px-3 py-2 text-chrome-silver text-xs">{ship.region || "—"}</td>
								<td class="px-3 py-2 text-center">
									{#if ship.commissionable}
										<span class="text-[10px] px-1.5 py-0.5 rounded bg-bio-green/20 text-bio-green">Yes</span>
									{:else}
										<span class="text-[10px] px-1.5 py-0.5 rounded bg-hull-grey/20 text-hull-grey">No</span>
									{/if}
								</td>
								<td class="px-3 py-2 text-plasma-cyan text-xs">{shipRoleFit(ship)}</td>
							</tr>
							{#if expandedShip === ship.id}
								<tr class="bg-nebula-blue/10">
									<td colspan="14" class="px-4 py-3">
										<div class="space-y-2">
											<p class="text-sm text-chrome-silver">{ship.description || "No description available."}</p>
											<div class="flex flex-wrap gap-4 text-xs text-hull-grey">
												<span>ID: <span class="text-chrome-silver mono">{ship.id}</span></span>
												{#if ship.region}
													<span>Region: <span class="text-plasma-cyan">{ship.region}</span></span>
												{:else if ship.extra?.faction}
													<span>Faction: <span class="text-plasma-cyan capitalize">{ship.extra.faction}</span></span>
												{/if}
												<span>Commission: <span class="{ship.commissionable ? 'text-bio-green' : 'text-hull-grey'}">{ship.commissionable ? 'Available for commission' : 'Not commissionable'}</span></span>
											</div>
											<div class="grid grid-cols-3 gap-4 mt-2 text-xs">
												<div class="bg-deep-void/50 rounded p-2">
													<div class="text-hull-grey mb-1">Survivability</div>
													<div class="text-star-white">Hull {formatNum(ship.hull)} + Shield {formatNum(ship.shield)} + Armor {formatNum(ship.armor)} = <span class="text-bio-green font-medium">{formatNum(ship.hull + ship.shield + ship.armor)} EHP</span></div>
												</div>
												<div class="bg-deep-void/50 rounded p-2">
													<div class="text-hull-grey mb-1">Capacity</div>
													<div class="text-star-white">Cargo {formatNum(ship.cargoCapacity)} | Fuel {formatNum(ship.fuel)} | CPU {ship.cpuCapacity} | Power {ship.powerCapacity}</div>
												</div>
												<div class="bg-deep-void/50 rounded p-2">
													<div class="text-hull-grey mb-1">Efficiency</div>
													<div class="text-star-white">
														Cargo/Credit: <span class="text-bio-green">{ship.basePrice > 0 ? (ship.cargoCapacity / ship.basePrice * 1000).toFixed(1) : "N/A"}</span> per 1k cr |
														Speed: <span class="text-plasma-cyan">{ship.speed}</span>
													</div>
												</div>
											</div>
											{#if ship.extra && Object.keys(ship.extra).length > 0}
												{@const ex = ship.extra}
												<!-- Ship classification -->
												{#if ex.class || ex.tier || ex.faction || ex.scale}
													<div class="flex gap-4 text-xs mt-1">
														{#if ex.class}<span class="text-hull-grey">Class: <span class="text-star-white">{ex.class}</span></span>{/if}
														{#if ex.tier}<span class="text-hull-grey">Tier: <span class="text-warning-yellow">{ex.tier}</span></span>{/if}
														{#if ex.scale}<span class="text-hull-grey">Scale: <span class="text-chrome-silver">{ex.scale}</span></span>{/if}
														{#if ex.faction}<span class="text-hull-grey">Faction: <span class="text-plasma-cyan capitalize">{ex.faction}</span></span>{/if}
														{#if ex.shipyard_tier}<span class="text-hull-grey">Shipyard Tier: <span class="text-chrome-silver">{ex.shipyard_tier}</span></span>{/if}
													</div>
												{/if}

												<!-- Slots -->
												{#if ex.weapon_slots !== undefined || ex.defense_slots !== undefined || ex.utility_slots !== undefined}
													<div class="bg-deep-void/50 rounded p-2 mt-2 text-xs">
														<div class="text-hull-grey mb-1">Slots</div>
														<div class="flex gap-4 text-star-white">
															<span>Weapon: <span class="mono text-claw-red">{ex.weapon_slots ?? 0}</span></span>
															<span>Defense: <span class="mono text-laser-blue">{ex.defense_slots ?? 0}</span></span>
															<span>Utility: <span class="mono text-bio-green">{ex.utility_slots ?? 0}</span></span>
															{#if ex.base_shield_recharge}<span>Shield Recharge: <span class="mono text-laser-blue">{ex.base_shield_recharge}/s</span></span>{/if}
														</div>
													</div>
												{/if}

												<!-- Default modules & required skills -->
												<div class="grid grid-cols-2 gap-4 mt-2 text-xs">
													{#if ex.default_modules && Array.isArray(ex.default_modules) && ex.default_modules.length > 0}
														<div class="bg-deep-void/50 rounded p-2">
															<div class="text-hull-grey mb-1">Default Modules</div>
															<div class="flex flex-wrap gap-1">
																{#each ex.default_modules as mod}
																	<span class="px-1.5 py-0.5 rounded bg-plasma-cyan/15 text-plasma-cyan">{String(mod).replace(/_/g, " ")}</span>
																{/each}
															</div>
														</div>
													{/if}
													{#if ex.required_skills && typeof ex.required_skills === "object"}
														<div class="bg-deep-void/50 rounded p-2">
															<div class="text-hull-grey mb-1">Required Skills</div>
															<div class="flex flex-wrap gap-1">
																{#each Object.entries(ex.required_skills) as [skill, level]}
																	<span class="px-1.5 py-0.5 rounded bg-warning-yellow/15 text-warning-yellow">{String(skill).replace(/_/g, " ")} Lv.{level}</span>
																{/each}
															</div>
														</div>
													{/if}
												</div>

												<!-- Build materials -->
												{#if ex.build_materials && Array.isArray(ex.build_materials) && ex.build_materials.length > 0}
													<div class="bg-deep-void/50 rounded p-2 mt-2 text-xs">
														<div class="text-hull-grey mb-1">Build Materials (Commission)</div>
														<div class="flex flex-wrap gap-2">
															{#each ex.build_materials as mat}
																{@const m = mat as Record<string, unknown>}
																<span class="px-1.5 py-0.5 rounded bg-bio-green/10 text-bio-green">
																	<span class="mono">{m.quantity ?? "?"}x</span> {String(m.item_id ?? m.itemId ?? "unknown").replace(/_/g, " ")}
																</span>
															{/each}
														</div>
													</div>
												{/if}

												<!-- Lore -->
												{#if ex.lore}
													<div class="mt-2 text-xs text-chrome-silver/70 italic leading-relaxed">
														{ex.lore}
													</div>
												{/if}

												<!-- Remaining extra fields not covered above -->
												{@const knownExtraKeys = new Set(["class", "tier", "scale", "faction", "shipyard_tier", "weapon_slots", "defense_slots", "utility_slots", "base_shield_recharge", "default_modules", "required_skills", "build_materials", "lore"])}
												{@const remaining = Object.entries(ex).filter(([k]) => !knownExtraKeys.has(k))}
												{#if remaining.length > 0}
													<div class="mt-1 text-[10px] text-hull-grey/60">
														{#each remaining as [key, val]}
															<span class="mr-2">{key}: {typeof val === "object" ? JSON.stringify(val) : String(val)}</span>
														{/each}
													</div>
												{/if}
											{/if}
										</div>
									</td>
								</tr>
							{/if}
						{/each}
					</tbody>
				</table>
				{#if getShips($catalogData).length === 0}
					<p class="text-center text-hull-grey py-8">No ships match your search.</p>
				{/if}
			</div>

		<!-- ════════ MODULES & ITEMS ════════ -->
		{:else if activeTab === "modules"}
			<div class="grid gap-2">
				{#each getItems($catalogData) as item (item.id)}
					<div
						class="border border-hull-grey/20 rounded px-4 py-2.5 hover:bg-nebula-blue/15 transition-colors
							{isModule(item) ? 'border-l-2 border-l-plasma-cyan/50' : ''}"
					>
						<div class="flex items-center gap-4">
							<div class="flex-1 min-w-0">
								<div class="flex items-center gap-2">
									<span class="text-star-white font-medium text-sm">{item.name}</span>
									{#if isModule(item)}
										<span class="text-[10px] px-1.5 py-0.5 rounded bg-plasma-cyan/20 text-plasma-cyan">MODULE</span>
									{/if}
								</div>
								<p class="text-xs text-chrome-silver mt-0.5 truncate">{item.description || "No description."}</p>
							</div>
							<div class="text-right shrink-0">
								<div class="text-xs text-hull-grey capitalize">{item.category}</div>
								<div class="text-sm mono text-warning-yellow">{formatNum(item.basePrice)} cr</div>
							</div>
							<div class="text-right shrink-0 w-16">
								<div class="text-xs text-hull-grey">Stack</div>
								<div class="text-sm mono text-chrome-silver">{item.stackSize}</div>
							</div>
							<div class="shrink-0 w-32">
								<div class="text-xs text-hull-grey mono">{item.id}</div>
							</div>
						</div>
					</div>
				{/each}
				{#if getItems($catalogData).length === 0}
					<p class="text-center text-hull-grey py-8">No items match your search.</p>
				{/if}
			</div>

		<!-- ════════ SKILLS ════════ -->
		{:else if activeTab === "skills"}
			<div class="grid gap-2">
				{#each getSkills($catalogData) as skill (skill.id)}
					<div
						class="border border-hull-grey/20 rounded px-4 py-2.5 hover:bg-nebula-blue/15 transition-colors cursor-pointer"
						onclick={() => expandedSkill = expandedSkill === skill.id ? null : skill.id}
					>
						<div class="flex items-center gap-4">
							<div class="flex-1 min-w-0">
								<div class="flex items-center gap-2">
									<span class="text-star-white font-medium text-sm">{skill.name}</span>
									<span class="text-[10px] px-1.5 py-0.5 rounded bg-nebula-blue text-chrome-silver capitalize">{skill.category}</span>
								</div>
								<p class="text-xs text-chrome-silver mt-0.5">{skill.description || "No description."}</p>
							</div>
							<div class="text-right shrink-0">
								<div class="text-xs text-hull-grey">Max Level</div>
								<div class="text-sm mono text-bio-green">{skill.maxLevel}</div>
							</div>
						</div>
						{#if expandedSkill === skill.id}
							<div class="mt-3 pt-3 border-t border-hull-grey/20 space-y-2">
								<div class="text-xs text-hull-grey">ID: <span class="text-chrome-silver mono">{skill.id}</span></div>
								{#if Object.keys(skill.prerequisites).length > 0}
									<div>
										<div class="text-xs text-hull-grey mb-1">Prerequisites:</div>
										<div class="flex flex-wrap gap-2">
											{#each Object.entries(skill.prerequisites) as [prereq, level]}
												<span class="text-xs px-2 py-1 rounded bg-claw-red/20 text-claw-red">
													{prereq} Lv.{level}
												</span>
											{/each}
										</div>
									</div>
								{:else}
									<div class="text-xs text-hull-grey">No prerequisites</div>
								{/if}
							</div>
						{/if}
					</div>
				{/each}
				{#if getSkills($catalogData).length === 0}
					<p class="text-center text-hull-grey py-8">No skills match your search.</p>
				{/if}
			</div>

		<!-- ════════ RECIPES ════════ -->
		{:else if activeTab === "recipes"}
			<div class="grid gap-2">
				{#each getRecipes($catalogData) as recipe (recipe.id)}
					<div
						class="border border-hull-grey/20 rounded px-4 py-2.5 hover:bg-nebula-blue/15 transition-colors cursor-pointer"
						onclick={() => expandedRecipe = expandedRecipe === recipe.id ? null : recipe.id}
					>
						<div class="flex items-center gap-4">
							<div class="flex-1 min-w-0">
								<div class="flex items-center gap-2">
									<span class="text-star-white font-medium text-sm">{recipe.name}</span>
									<span class="text-xs text-hull-grey">-></span>
									<span class="text-sm text-bio-green">{recipe.outputQuantity}x {resolveItemName($catalogData, recipe.outputItem)}</span>
								</div>
								<p class="text-xs text-chrome-silver mt-0.5">{recipe.description || "No description."}</p>
							</div>
							<div class="text-right shrink-0">
								<div class="text-xs text-hull-grey">Ingredients</div>
								<div class="text-sm mono text-chrome-silver">{recipe.ingredients.length}</div>
							</div>
							<div class="text-right shrink-0">
								<div class="text-xs text-hull-grey">Skills</div>
								<div class="text-sm mono text-chrome-silver">{Object.keys(recipe.requiredSkills).length}</div>
							</div>
						</div>
						{#if expandedRecipe === recipe.id}
							<div class="mt-3 pt-3 border-t border-hull-grey/20 grid grid-cols-3 gap-4">
								<div>
									<div class="text-xs text-hull-grey mb-1.5">Ingredients</div>
									<div class="space-y-1">
										{#each recipe.ingredients as ing}
											<div class="flex items-center gap-2 text-xs">
												<span class="text-warning-yellow mono">{ing.quantity}x</span>
												<span class="text-star-white">{resolveItemName($catalogData, ing.itemId)}</span>
												<span class="text-hull-grey mono">({ing.itemId})</span>
											</div>
										{/each}
									</div>
								</div>
								<div>
									<div class="text-xs text-hull-grey mb-1.5">Required Skills</div>
									{#if Object.keys(recipe.requiredSkills).length > 0}
										<div class="space-y-1">
											{#each Object.entries(recipe.requiredSkills) as [skillId, level]}
												<div class="text-xs">
													<span class="text-plasma-cyan">{skillId}</span>
													<span class="text-chrome-silver"> Lv.{level}</span>
												</div>
											{/each}
										</div>
									{:else}
										<div class="text-xs text-hull-grey">None</div>
									{/if}
								</div>
								<div>
									<div class="text-xs text-hull-grey mb-1.5">XP Rewards</div>
									{#if Object.keys(recipe.xpRewards).length > 0}
										<div class="space-y-1">
											{#each Object.entries(recipe.xpRewards) as [skillId, xp]}
												<div class="text-xs">
													<span class="text-bio-green">+{xp}</span>
													<span class="text-chrome-silver"> {skillId}</span>
												</div>
											{/each}
										</div>
									{:else}
										<div class="text-xs text-hull-grey">None</div>
									{/if}
									<div class="mt-2 text-xs text-hull-grey">
										Output: <span class="text-bio-green mono">{recipe.outputQuantity}x</span> <span class="text-star-white">{resolveItemName($catalogData, recipe.outputItem)}</span>
									</div>
									<div class="text-xs text-hull-grey mono mt-1">ID: {recipe.id}</div>
								</div>
							</div>
						{/if}
					</div>
				{/each}
				{#if getRecipes($catalogData).length === 0}
					<p class="text-center text-hull-grey py-8">No recipes match your search.</p>
				{/if}
			</div>
		{/if}
	{/if}
</div>
