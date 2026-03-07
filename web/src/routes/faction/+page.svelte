<script lang="ts">
	import { factionState, economy } from "$stores/websocket";

	type FactionTab = "overview" | "storage_tx" | "credits_tx";
	type TxRange = "1h" | "1d" | "1w";

	let activeTab = $state<FactionTab>("overview");
	let txRange = $state<TxRange>("1d");

	interface FactionTx {
		timestamp: number;
		botId: string | null;
		type: string;
		itemId: string | null;
		itemName: string | null;
		quantity: number | null;
		credits: number | null;
		details: string | null;
	}

	let transactions = $state<FactionTx[]>([]);

	const TX_RANGES: { label: string; value: TxRange }[] = [
		{ label: "1H", value: "1h" },
		{ label: "1D", value: "1d" },
		{ label: "1W", value: "1w" },
	];

	async function fetchTransactions(r: TxRange) {
		try {
			const res = await fetch(`/api/faction/transactions?range=${r}&limit=500`);
			if (res.ok) transactions = await res.json();
		} catch { /* silent */ }
	}

	$effect(() => {
		if (activeTab === "storage_tx" || activeTab === "credits_tx") fetchTransactions(txRange);
	});
	$effect(() => {
		if (activeTab !== "storage_tx" && activeTab !== "credits_tx") return;
		const interval = setInterval(() => fetchTransactions(txRange), 15_000);
		return () => clearInterval(interval);
	});

	const storageTx = $derived(transactions.filter(t =>
		t.type === "item_deposit" || t.type === "item_withdraw" || t.type === "sell_order" || t.type === "buy_order"
	));

	const creditsTx = $derived(transactions.filter(t =>
		t.type === "credit_deposit" || t.type === "credit_withdraw"
	));

	const creditsSummary = $derived.by(() => {
		let deposited = 0, withdrawn = 0;
		for (const t of creditsTx) {
			if (t.type === "credit_deposit") deposited += (t.credits ?? 0);
			else withdrawn += (t.credits ?? 0);
		}
		return { deposited, withdrawn, net: deposited - withdrawn };
	});

	const storageSummary = $derived.by(() => {
		let depositsCount = 0, withdrawsCount = 0, sellsCount = 0;
		for (const t of storageTx) {
			if (t.type === "item_deposit") depositsCount++;
			else if (t.type === "item_withdraw") withdrawsCount++;
			else sellsCount++;
		}
		return { depositsCount, withdrawsCount, sellsCount };
	});

	function formatItemName(id: string): string {
		return id.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
	}

	function formatTxTime(ts: number): string {
		const d = new Date(ts);
		return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
	}

	function txTypeLabel(type: string): string {
		switch (type) {
			case "item_deposit": return "DEPOSIT";
			case "item_withdraw": return "WITHDRAW";
			case "sell_order": return "SELL";
			case "buy_order": return "BUY";
			case "credit_deposit": return "DEPOSIT";
			case "credit_withdraw": return "WITHDRAW";
			default: return type;
		}
	}

	function txTypeColor(type: string): string {
		switch (type) {
			case "item_deposit": case "credit_deposit": return "bg-bio-green/20 text-bio-green";
			case "item_withdraw": case "credit_withdraw": return "bg-shell-orange/20 text-shell-orange";
			case "sell_order": return "bg-plasma-cyan/20 text-plasma-cyan";
			case "buy_order": return "bg-claw-red/20 text-claw-red";
			default: return "bg-hull-grey/20 text-hull-grey";
		}
	}

	const totalStorageItems = $derived(
		($factionState?.storage ?? []).reduce((sum, i) => sum + i.quantity, 0)
	);

	const storageByCategory = $derived(() => {
		const items = $factionState?.storage ?? [];
		const cats: Record<string, typeof items> = {};
		for (const item of items) {
			const cat = item.itemId.startsWith("ore_")
				? "Ores"
				: item.itemId.startsWith("refined_")
					? "Refined"
					: item.itemId.startsWith("component_")
						? "Components"
						: item.itemId.startsWith("module_")
							? "Modules"
							: "Other";
			if (!cats[cat]) cats[cat] = [];
			cats[cat].push(item);
		}
		// Sort each category by quantity desc
		for (const cat of Object.keys(cats)) {
			cats[cat].sort((a, b) => b.quantity - a.quantity);
		}
		return cats;
	});

	const onlineMembers = $derived(
		($factionState?.members ?? []).filter((m) => m.online).length
	);
</script>

<svelte:head>
	<title>Faction - SpaceMolt Commander</title>
</svelte:head>

<div class="space-y-4">
	<div class="flex items-center justify-between">
		<div class="flex items-center gap-3">
			<h1 class="text-2xl font-bold text-star-white">Faction</h1>
			{#if $factionState?.tag}
				<span class="text-sm font-mono px-2 py-0.5 rounded bg-void-purple/20 text-void-purple border border-void-purple/30">
					[{$factionState.tag}]
				</span>
			{/if}
			{#if $factionState?.name}
				<span class="text-chrome-silver text-sm">{$factionState.name}</span>
			{/if}
		</div>
		<div class="flex items-center gap-2">
			{#if $factionState?.commanderAware}
				<span class="text-xs px-2 py-1 rounded bg-bio-green/10 text-bio-green border border-bio-green/30">
					Commander Aware
				</span>
			{:else}
				<span class="text-xs px-2 py-1 rounded bg-hull-grey/10 text-hull-grey border border-hull-grey/30">
					Commander Not Using Faction Storage
				</span>
			{/if}
			<div class="flex gap-1 bg-deep-void rounded-lg p-0.5">
				<button class="px-3 py-1 text-xs rounded-md transition-colors {activeTab === 'overview'
					? 'bg-plasma-cyan/20 text-plasma-cyan' : 'text-hull-grey hover:text-chrome-silver'}"
					onclick={() => activeTab = "overview"}>Overview</button>
				<button class="px-3 py-1 text-xs rounded-md transition-colors {activeTab === 'storage_tx'
					? 'bg-plasma-cyan/20 text-plasma-cyan' : 'text-hull-grey hover:text-chrome-silver'}"
					onclick={() => activeTab = "storage_tx"}>Storage Log</button>
				<button class="px-3 py-1 text-xs rounded-md transition-colors {activeTab === 'credits_tx'
					? 'bg-plasma-cyan/20 text-plasma-cyan' : 'text-hull-grey hover:text-chrome-silver'}"
					onclick={() => activeTab = "credits_tx"}>Credits Log</button>
			</div>
		</div>
	</div>

	{#if !$factionState?.id}
		<!-- No faction -->
		<div class="card p-12 text-center">
			<p class="text-xl text-hull-grey mb-2">No Faction</p>
			<p class="text-sm text-hull-grey/70">
				Bots are not in a faction, or no bot is logged in yet.
			</p>
		</div>
	{:else}
		<!-- Summary cards -->
		<div class="grid grid-cols-2 md:grid-cols-4 gap-3">
			<div class="card p-4">
				<p class="text-xs text-chrome-silver uppercase tracking-wider">Treasury</p>
				<p class="text-2xl font-bold mono text-bio-green mt-1">
					{$factionState.credits.toLocaleString()}
				</p>
				<p class="text-xs text-hull-grey mt-1">credits</p>
			</div>
			<div class="card p-4">
				<p class="text-xs text-chrome-silver uppercase tracking-wider">Storage Items</p>
				<p class="text-2xl font-bold mono text-plasma-cyan mt-1">
					{totalStorageItems.toLocaleString()}
				</p>
				<p class="text-xs text-hull-grey mt-1">
					{$factionState.storage.length} type(s)
				</p>
			</div>
			<div class="card p-4">
				<p class="text-xs text-chrome-silver uppercase tracking-wider">Members</p>
				<p class="text-2xl font-bold mono text-star-white mt-1">
					{$factionState.memberCount}
				</p>
				<p class="text-xs text-hull-grey mt-1">
					{onlineMembers} online
				</p>
			</div>
			<div class="card p-4">
				<p class="text-xs text-chrome-silver uppercase tracking-wider">Storage Mode</p>
				<p class="text-lg font-bold mt-1 capitalize {$factionState.storageMode === 'faction_deposit' ? 'text-void-purple' : 'text-hull-grey'}">
					{$factionState.storageMode.replace(/_/g, " ")}
				</p>
				<p class="text-xs text-hull-grey mt-1">fleet default</p>
			</div>
		</div>

		{#if activeTab === "overview"}
		<div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
			<!-- Storage (2/3 width) -->
			<div class="lg:col-span-2 card p-4">
				<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-3">
					Faction Storage
				</h2>
				{#if $factionState.storage.length === 0}
					<p class="text-sm text-hull-grey py-8 text-center">Storage is empty</p>
				{:else}
					<div class="space-y-4">
						{#each Object.entries(storageByCategory()) as [category, items]}
							<div>
								<h3 class="text-xs text-hull-grey uppercase tracking-wider mb-2">{category}</h3>
								<div class="grid grid-cols-1 sm:grid-cols-2 gap-1">
									{#each items as item}
										<div class="flex items-center justify-between py-1.5 px-2 rounded bg-deep-void/50 hover:bg-nebula-blue/20 transition-colors">
											<span class="text-sm text-star-white">{item.itemName}</span>
											<span class="mono text-sm font-medium {category === 'Ores' ? 'text-shell-orange' : category === 'Refined' ? 'text-plasma-cyan' : category === 'Components' ? 'text-void-purple' : 'text-chrome-silver'}">
												{item.quantity.toLocaleString()}
											</span>
										</div>
									{/each}
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</div>

			<!-- Members + Diplomacy (1/3 width) -->
			<div class="space-y-4">
				<!-- Members -->
				<div class="card p-4">
					<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-3">
						Members
					</h2>
					{#if $factionState.members.length === 0}
						<p class="text-sm text-hull-grey py-4 text-center">
							{$factionState.memberCount} member(s) — details not available
						</p>
					{:else}
						<div class="space-y-1 max-h-[300px] overflow-y-auto">
							{#each $factionState.members.sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0)) as member}
								<div class="flex items-center justify-between py-1.5 px-2 rounded hover:bg-nebula-blue/20 transition-colors">
									<div class="flex items-center gap-2">
										<span class="w-2 h-2 rounded-full shrink-0 {member.online ? 'bg-bio-green' : 'bg-hull-grey/40'}"></span>
										<span class="text-sm {member.online ? 'text-star-white' : 'text-hull-grey'}">{member.username}</span>
									</div>
									<span class="text-xs capitalize px-1.5 py-0.5 rounded
										{member.role === 'leader' ? 'bg-warning-yellow/20 text-warning-yellow' :
										 member.role === 'officer' ? 'bg-laser-blue/20 text-laser-blue' :
										 'bg-hull-grey/10 text-hull-grey'}">
										{member.role}
									</span>
								</div>
							{/each}
						</div>
					{/if}
				</div>

				<!-- Facilities -->
				<div class="card p-4">
					<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-3">
						Facilities
					</h2>
					{#if $factionState.facilities.length === 0}
						<p class="text-sm text-hull-grey py-4 text-center">No facilities</p>
					{:else}
						<div class="space-y-2">
							{#each $factionState.facilities as facility}
								<div class="py-2 px-2 rounded bg-deep-void/50">
									<div class="flex items-center justify-between">
										<span class="text-sm text-star-white font-medium">{facility.name}</span>
										<span class="text-xs capitalize px-1.5 py-0.5 rounded
											{facility.status === 'active' ? 'bg-bio-green/20 text-bio-green' : 'bg-hull-grey/10 text-hull-grey'}">
											{facility.status}
										</span>
									</div>
									<div class="flex items-center gap-2 mt-1 text-xs text-hull-grey">
										<span>{facility.type.replace(/_/g, " ")}</span>
										{#if facility.systemName}
											<span>- {facility.systemName}</span>
										{/if}
									</div>
								</div>
							{/each}
						</div>
					{/if}
				</div>

				<!-- Diplomacy -->
				<div class="card p-4">
					<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-3">
						Diplomacy
					</h2>
					<div class="space-y-3">
						<div>
							<h3 class="text-xs text-bio-green mb-1.5">Allies</h3>
							{#if $factionState.allies.length === 0}
								<p class="text-xs text-hull-grey">None</p>
							{:else}
								{#each $factionState.allies as ally}
									<div class="text-sm text-star-white py-0.5">{ally.name}</div>
								{/each}
							{/if}
						</div>
						<div>
							<h3 class="text-xs text-claw-red mb-1.5">Enemies</h3>
							{#if $factionState.enemies.length === 0}
								<p class="text-xs text-hull-grey">None</p>
							{:else}
								{#each $factionState.enemies as enemy}
									<div class="text-sm text-star-white py-0.5">{enemy.name}</div>
								{/each}
							{/if}
						</div>
					</div>
				</div>
			</div>
		</div>

		<!-- Faction Orders -->
		<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
			<!-- Buy Orders -->
			<div class="card p-4">
				<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-3">
					Faction Buy Orders
					{#if ($factionState.orders ?? []).filter(o => o.type === "buy").length > 0}
						<span class="text-hull-grey font-normal ml-1">({($factionState.orders ?? []).filter(o => o.type === "buy").length})</span>
					{/if}
				</h2>
				{#if ($factionState.orders ?? []).filter(o => o.type === "buy").length === 0}
					<p class="text-sm text-hull-grey py-4 text-center">No active faction buy orders</p>
				{:else}
					<div class="space-y-1">
						{#each ($factionState.orders ?? []).filter(o => o.type === "buy") as order}
							<div class="flex items-center justify-between py-1.5 px-2 rounded bg-deep-void/50">
								<div>
									<span class="text-sm text-star-white">{order.itemName}</span>
									<span class="text-xs text-hull-grey ml-2">@ {order.stationName}</span>
								</div>
								<div class="text-right text-xs">
									<span class="mono text-bio-green">{order.priceEach.toLocaleString()} cr</span>
									<span class="text-hull-grey ml-1">x{order.quantity}</span>
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</div>

			<!-- Sell Orders -->
			<div class="card p-4">
				<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-3">
					Faction Sell Orders
					{#if ($factionState.orders ?? []).filter(o => o.type === "sell").length > 0}
						<span class="text-hull-grey font-normal ml-1">({($factionState.orders ?? []).filter(o => o.type === "sell").length})</span>
					{/if}
				</h2>
				{#if ($factionState.orders ?? []).filter(o => o.type === "sell").length === 0}
					<p class="text-sm text-hull-grey py-4 text-center">No active faction sell orders</p>
				{:else}
					<div class="space-y-1">
						{#each ($factionState.orders ?? []).filter(o => o.type === "sell") as order}
							<div class="flex items-center justify-between py-1.5 px-2 rounded bg-deep-void/50">
								<div>
									<span class="text-sm text-star-white">{order.itemName}</span>
									<span class="text-xs text-hull-grey ml-2">@ {order.stationName}</span>
								</div>
								<div class="text-right text-xs">
									<span class="mono text-shell-orange">{order.priceEach.toLocaleString()} cr</span>
									<span class="text-hull-grey ml-1">x{order.quantity}</span>
									{#if order.filled > 0}
										<span class="text-bio-green ml-1">({order.filled} filled)</span>
									{/if}
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</div>
		</div>

		<!-- Faction Missions -->
		<div class="card p-4">
			<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-3">
				Faction Missions
				{#if ($factionState.missions ?? []).length > 0}
					<span class="text-hull-grey font-normal ml-1">({($factionState.missions ?? []).length})</span>
				{/if}
			</h2>
			{#if ($factionState.missions ?? []).length === 0}
				<p class="text-sm text-hull-grey py-4 text-center">No active faction missions</p>
			{:else}
				<div class="space-y-2">
					{#each $factionState.missions ?? [] as mission}
						<div class="py-2 px-3 rounded bg-deep-void/50 border border-hull-grey/10">
							<div class="flex items-center justify-between">
								<span class="text-sm text-star-white font-medium">{mission.title}</span>
								<div class="flex items-center gap-2">
									<span class="text-[10px] uppercase px-1.5 py-0.5 rounded
										{mission.type === 'delivery' ? 'bg-plasma-cyan/20 text-plasma-cyan' :
										 mission.type === 'combat' ? 'bg-claw-red/20 text-claw-red' :
										 'bg-hull-grey/20 text-hull-grey'}">{mission.type}</span>
									<span class="text-[10px] uppercase px-1.5 py-0.5 rounded
										{mission.status === 'active' ? 'bg-bio-green/20 text-bio-green' :
										 mission.status === 'completed' ? 'bg-warning-yellow/20 text-warning-yellow' :
										 'bg-hull-grey/20 text-hull-grey'}">{mission.status}</span>
								</div>
							</div>
							{#if mission.description}
								<p class="text-xs text-hull-grey mt-1">{mission.description}</p>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		</div>

		<!-- Intel Coverage -->
		{#if $factionState.intelCoverage || $factionState.tradeIntelCoverage}
		<div class="grid grid-cols-1 md:grid-cols-2 gap-4">
			{#if $factionState.intelCoverage}
				<div class="card p-4">
					<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-2">System Intel Coverage</h2>
					<div class="flex items-center gap-3">
						<div class="flex-1 h-2 bg-hull-grey/20 rounded-full overflow-hidden">
							<div class="h-full bg-plasma-cyan rounded-full" style="width:{Math.round($factionState.intelCoverage.systemsSubmitted / Math.max(1, $factionState.intelCoverage.totalSystems) * 100)}%"></div>
						</div>
						<span class="mono text-xs text-chrome-silver">{$factionState.intelCoverage.systemsSubmitted}/{$factionState.intelCoverage.totalSystems}</span>
					</div>
				</div>
			{/if}
			{#if $factionState.tradeIntelCoverage}
				<div class="card p-4">
					<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-2">Trade Intel Coverage</h2>
					<div class="flex items-center gap-3">
						<div class="flex-1 h-2 bg-hull-grey/20 rounded-full overflow-hidden">
							<div class="h-full bg-bio-green rounded-full" style="width:{Math.round($factionState.tradeIntelCoverage.stationsSubmitted / Math.max(1, $factionState.tradeIntelCoverage.totalStations) * 100)}%"></div>
						</div>
						<span class="mono text-xs text-chrome-silver">{$factionState.tradeIntelCoverage.stationsSubmitted}/{$factionState.tradeIntelCoverage.totalStations}</span>
					</div>
				</div>
			{/if}
		</div>
		{/if}

		<!-- Commander Integration Info -->
		<div class="card p-4">
			<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-3">
				Commander Integration
			</h2>
			<div class="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
				<div>
					<p class="text-chrome-silver mb-1">Faction Storage in Scoring</p>
					<p class="{$factionState.commanderAware ? 'text-bio-green' : 'text-hull-grey'}">
						{$factionState.commanderAware ? "Active" : "Inactive"}
					</p>
					<p class="text-xs text-hull-grey mt-1">
						{#if $factionState.commanderAware}
							Commander boosts miners when storage is low, boosts crafters when ore is available
						{:else}
							Set fleet storage mode to "faction_deposit" in Settings to enable
						{/if}
					</p>
				</div>
				{#if $factionState}
					{@const oreTotal = $factionState.storage.filter(i => i.itemId.startsWith("ore_")).reduce((sum, i) => sum + i.quantity, 0)}
					<div>
						<p class="text-chrome-silver mb-1">Ore in Faction Storage</p>
						<p class="mono text-shell-orange">{oreTotal.toLocaleString()}</p>
						<p class="text-xs text-hull-grey mt-1">
							{#if oreTotal < 20}
								Low — miners get priority boost
							{:else if oreTotal >= 50}
								High — crafters get priority boost
							{:else}
								Moderate supply level
							{/if}
						</p>
					</div>
				{/if}
				<div>
					<p class="text-chrome-silver mb-1">Supply Chain Status</p>
					{#if $economy?.deficits?.length}
						<p class="text-warning-yellow">{$economy.deficits.length} deficit(s)</p>
					{:else}
						<p class="text-bio-green">Healthy</p>
					{/if}
					<p class="text-xs text-hull-grey mt-1">
						Based on fleet production/consumption rates
					</p>
				</div>
			</div>
		</div>

		{:else if activeTab === "storage_tx"}
		<!-- STORAGE TRANSACTIONS TAB -->
		<div class="card p-4">
			<div class="flex items-center justify-between mb-3">
				<div>
					<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider">
						Faction Storage Transactions
					</h2>
					{#if storageTx.length > 0}
						<p class="text-xs text-hull-grey mt-0.5">
							{storageSummary.depositsCount} deposits &middot;
							{storageSummary.withdrawsCount} withdrawals &middot;
							{storageSummary.sellsCount} sells
						</p>
					{/if}
				</div>
				<div class="flex gap-1">
					{#each TX_RANGES as r}
						<button
							class="px-2 py-0.5 text-xs rounded transition-colors {txRange === r.value
								? 'bg-plasma-cyan/20 text-plasma-cyan'
								: 'text-hull-grey hover:text-chrome-silver'}"
							onclick={() => txRange = r.value}
						>{r.label}</button>
					{/each}
				</div>
			</div>

			{#if storageTx.length === 0}
				<p class="text-sm text-hull-grey py-8 text-center">No storage transactions recorded</p>
			{:else}
				<div class="overflow-x-auto max-h-[500px] overflow-y-auto">
					<table class="w-full text-xs">
						<thead class="sticky top-0 bg-deep-void">
							<tr class="text-left text-[10px] text-chrome-silver uppercase tracking-wider border-b border-hull-grey/30">
								<th class="pb-1.5 pr-3">Time</th>
								<th class="pb-1.5 pr-3">Bot</th>
								<th class="pb-1.5 pr-3">Action</th>
								<th class="pb-1.5 pr-3">Item</th>
								<th class="pb-1.5 pr-3 text-right">Qty</th>
								<th class="pb-1.5 text-right">Value</th>
							</tr>
						</thead>
						<tbody class="divide-y divide-hull-grey/10">
							{#each storageTx as tx}
								<tr class="hover:bg-nebula-blue/10 transition-colors">
									<td class="py-1.5 pr-3 text-hull-grey mono whitespace-nowrap">{formatTxTime(tx.timestamp)}</td>
									<td class="py-1.5 pr-3 text-laser-blue truncate max-w-[80px]">{tx.botId ?? "—"}</td>
									<td class="py-1.5 pr-3">
										<span class="font-medium px-1.5 py-0.5 rounded text-[10px] {txTypeColor(tx.type)}">
											{txTypeLabel(tx.type)}
										</span>
									</td>
									<td class="py-1.5 pr-3 text-star-white">{tx.itemName ?? formatItemName(tx.itemId ?? "")}</td>
									<td class="py-1.5 pr-3 text-right mono text-chrome-silver">{tx.quantity ?? "—"}</td>
									<td class="py-1.5 text-right mono {tx.credits && tx.credits > 0 ? 'text-bio-green' : 'text-hull-grey'}">
										{tx.credits ? `${tx.credits.toLocaleString()} cr` : "—"}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</div>

		{:else if activeTab === "credits_tx"}
		<!-- CREDITS TRANSACTIONS TAB -->
		<div class="grid grid-cols-3 gap-3 mb-4">
			<div class="card p-3">
				<p class="text-[10px] text-chrome-silver uppercase tracking-wider">Deposited</p>
				<p class="text-xl font-bold mono text-bio-green mt-0.5">{creditsSummary.deposited.toLocaleString()}</p>
			</div>
			<div class="card p-3">
				<p class="text-[10px] text-chrome-silver uppercase tracking-wider">Withdrawn</p>
				<p class="text-xl font-bold mono text-shell-orange mt-0.5">{creditsSummary.withdrawn.toLocaleString()}</p>
			</div>
			<div class="card p-3">
				<p class="text-[10px] text-chrome-silver uppercase tracking-wider">Net Flow</p>
				<p class="text-xl font-bold mono mt-0.5 {creditsSummary.net >= 0 ? 'text-bio-green' : 'text-claw-red'}">
					{creditsSummary.net >= 0 ? "+" : ""}{creditsSummary.net.toLocaleString()}
				</p>
			</div>
		</div>

		<div class="card p-4">
			<div class="flex items-center justify-between mb-3">
				<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider">
					Faction Credit Transactions
				</h2>
				<div class="flex gap-1">
					{#each TX_RANGES as r}
						<button
							class="px-2 py-0.5 text-xs rounded transition-colors {txRange === r.value
								? 'bg-plasma-cyan/20 text-plasma-cyan'
								: 'text-hull-grey hover:text-chrome-silver'}"
							onclick={() => txRange = r.value}
						>{r.label}</button>
					{/each}
				</div>
			</div>

			{#if creditsTx.length === 0}
				<p class="text-sm text-hull-grey py-8 text-center">No credit transactions recorded</p>
			{:else}
				<div class="overflow-x-auto max-h-[500px] overflow-y-auto">
					<table class="w-full text-xs">
						<thead class="sticky top-0 bg-deep-void">
							<tr class="text-left text-[10px] text-chrome-silver uppercase tracking-wider border-b border-hull-grey/30">
								<th class="pb-1.5 pr-3">Time</th>
								<th class="pb-1.5 pr-3">Bot</th>
								<th class="pb-1.5 pr-3">Action</th>
								<th class="pb-1.5 pr-3 text-right">Amount</th>
								<th class="pb-1.5">Details</th>
							</tr>
						</thead>
						<tbody class="divide-y divide-hull-grey/10">
							{#each creditsTx as tx}
								<tr class="hover:bg-nebula-blue/10 transition-colors">
									<td class="py-1.5 pr-3 text-hull-grey mono whitespace-nowrap">{formatTxTime(tx.timestamp)}</td>
									<td class="py-1.5 pr-3 text-laser-blue truncate max-w-[80px]">{tx.botId ?? "—"}</td>
									<td class="py-1.5 pr-3">
										<span class="font-medium px-1.5 py-0.5 rounded text-[10px] {txTypeColor(tx.type)}">
											{txTypeLabel(tx.type)}
										</span>
									</td>
									<td class="py-1.5 pr-3 text-right mono font-medium {tx.type === 'credit_deposit' ? 'text-bio-green' : 'text-shell-orange'}">
										{tx.type === 'credit_deposit' ? '+' : '-'}{(tx.credits ?? 0).toLocaleString()} cr
									</td>
									<td class="py-1.5 text-hull-grey text-[11px]">{tx.details ?? "—"}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</div>
		{/if}
	{/if}
</div>
