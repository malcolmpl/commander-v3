<script lang="ts">
	import { economy } from "$stores/websocket";
	import ProfitChart from "$lib/components/ProfitChart.svelte";
	import SupplyChainFlow from "$lib/components/SupplyChainFlow.svelte";
	import PriceHistory from "$lib/components/PriceHistory.svelte";

	type TradeRange = "1h" | "1d" | "1w" | "all";
	type Tab = "overview" | "market";

	let activeTab = $state<Tab>("overview");
	let tradeRange = $state<TradeRange>("1d");
	let selectedItem = $state("");
	let sortBy = $state<"name" | "spread" | "buy" | "sell">("spread");
	let sortDir = $state<"asc" | "desc">("desc");
	let expandedItem = $state<string | null>(null);

	let trades = $state<Array<{
		timestamp: number;
		botId: string;
		action: string;
		itemId: string;
		quantity: number;
		priceEach: number;
		total: number;
		stationId: string | null;
	}>>([]);

	// Market data fetched from API (replaces WebSocket marketStations)
	let marketStationsData = $state<Array<{
		stationId: string;
		stationName: string;
		prices: Array<{ itemId: string; itemName: string; buyPrice: number; sellPrice: number; buyVolume: number; sellVolume: number }>;
		fetchedAt: number;
	}>>([]);

	const TRADE_RANGES: { label: string; value: TradeRange }[] = [
		{ label: "1H", value: "1h" },
		{ label: "1D", value: "1d" },
		{ label: "1W", value: "1w" },
		{ label: "ALL", value: "all" },
	];

	async function fetchTrades(r: TradeRange) {
		try {
			const res = await fetch(`/api/economy/trades?range=${r}&limit=200`);
			if (res.ok) trades = await res.json();
		} catch { /* silent */ }
	}

	async function fetchMarketData() {
		try {
			const res = await fetch("/api/economy/market?range=1d");
			if (res.ok) marketStationsData = await res.json();
		} catch { /* silent */ }
	}

	$effect(() => { fetchTrades(tradeRange); });
	$effect(() => {
		const interval = setInterval(() => fetchTrades(tradeRange), 15_000);
		return () => clearInterval(interval);
	});

	// Fetch market data on tab switch and periodically
	$effect(() => {
		if (activeTab === "market") fetchMarketData();
	});
	$effect(() => {
		if (activeTab !== "market") return;
		const interval = setInterval(fetchMarketData, 60_000);
		return () => clearInterval(interval);
	});

	// ── Order helpers ──
	const buyOrders = $derived(($economy?.openOrders ?? []).filter(o => o.type === "buy"));
	const sellOrders = $derived(($economy?.openOrders ?? []).filter(o => o.type === "sell"));

	function orderAge(createdAt: string): string {
		if (!createdAt) return "—";
		const age = Math.floor((Date.now() - new Date(createdAt).getTime()) / 60_000);
		if (age < 0) return "—";
		if (age < 60) return `${age}m`;
		if (age < 1440) return `${Math.floor(age / 60)}h`;
		return `${Math.floor(age / 1440)}d`;
	}

	function orderAgeClass(createdAt: string): string {
		if (!createdAt) return "text-hull-grey";
		const age = (Date.now() - new Date(createdAt).getTime()) / 60_000;
		return age > 120 ? "text-shell-orange" : age > 60 ? "text-warning-yellow" : "text-hull-grey";
	}

	// ── Trade summary ──
	const tradeSummary = $derived.by(() => {
		let totalRevenue = 0, totalCosts = 0, sellCount = 0, buyCount = 0;
		for (const t of trades) {
			if (t.action === "sell") { totalRevenue += t.total; sellCount++; }
			else { totalCosts += t.total; buyCount++; }
		}
		return { totalRevenue, totalCosts, netProfit: totalRevenue - totalCosts, sellCount, buyCount };
	});

	// ── Market grid ──
	interface StationPrice {
		stationId: string; stationName: string;
		buyPrice: number; sellPrice: number;
		buyVolume: number; sellVolume: number;
		fetchedAt: number;
	}
	interface GridItem {
		itemId: string; itemName: string; stations: StationPrice[];
		bestBuy: number; bestBuyStation: string;
		bestSell: number; bestSellStation: string;
		totalBuyVolume: number; totalSellVolume: number;
		spread: number;
	}

	const gridItems = $derived.by(() => {
		const items = new Map<string, GridItem>();
		for (const st of marketStationsData) {
			for (const p of st.prices) {
				let item = items.get(p.itemId);
				if (!item) {
					item = { itemId: p.itemId, itemName: p.itemName, stations: [],
						bestBuy: Infinity, bestBuyStation: "", bestSell: 0, bestSellStation: "",
						totalBuyVolume: 0, totalSellVolume: 0, spread: 0 };
					items.set(p.itemId, item);
				}
				item.stations.push({ stationId: st.stationId, stationName: st.stationName,
					buyPrice: p.buyPrice, sellPrice: p.sellPrice,
					buyVolume: p.buyVolume, sellVolume: p.sellVolume, fetchedAt: st.fetchedAt });
				item.totalBuyVolume += p.buyVolume;
				item.totalSellVolume += p.sellVolume;
				if (p.buyPrice > 0 && p.buyPrice < item.bestBuy) { item.bestBuy = p.buyPrice; item.bestBuyStation = st.stationName; }
				if (p.sellPrice > 0 && p.sellPrice > item.bestSell) { item.bestSell = p.sellPrice; item.bestSellStation = st.stationName; }
			}
		}
		for (const item of items.values()) {
			if (item.bestBuy < Infinity && item.bestSell > 0) item.spread = item.bestSell - item.bestBuy;
			if (item.bestBuy === Infinity) item.bestBuy = 0;
			item.stations.sort((a, b) => b.sellPrice - a.sellPrice);
		}
		return [...items.values()];
	});

	const displayItems = $derived.by(() => {
		const dir = sortDir === "asc" ? 1 : -1;
		return [...gridItems].sort((a, b) => {
			switch (sortBy) {
				case "name": return a.itemName.localeCompare(b.itemName) * dir;
				case "spread": return (a.spread - b.spread) * dir;
				case "buy": return (a.bestBuy - b.bestBuy) * dir;
				case "sell": return (a.bestSell - b.bestSell) * dir;
				default: return 0;
			}
		});
	});

	const arbitrageOpps = $derived.by(() => {
		return gridItems.filter(i => i.spread > 0 && i.stations.length >= 2)
			.sort((a, b) => b.spread - a.spread).slice(0, 8)
			.map(i => ({ item: i.itemName, itemId: i.itemId, buyAt: i.bestBuyStation,
				buyPrice: i.bestBuy, sellAt: i.bestSellStation, sellPrice: i.bestSell, profit: i.spread }));
	});

	const maxSpread = $derived(Math.max(1, ...gridItems.map(i => i.spread)));

	function formatItemName(itemId: string): string {
		return itemId.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
	}

	function formatTime(ts: number): string {
		const d = new Date(ts);
		if (tradeRange === "1h" || tradeRange === "1d")
			return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
		return d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " +
			d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	}

	function toggleSort(col: typeof sortBy) {
		if (sortBy === col) sortDir = sortDir === "asc" ? "desc" : "asc";
		else { sortBy = col; sortDir = col === "name" ? "asc" : "desc"; }
	}

	function sortIcon(col: typeof sortBy): string {
		if (sortBy !== col) return "";
		return sortDir === "asc" ? " ▲" : " ▼";
	}

	function spreadBg(spread: number): string {
		if (spread <= 0) return "";
		const t = Math.min(spread / maxSpread, 1);
		return `background-color: rgba(45,212,191,${(0.08 + t * 0.25).toFixed(2)})`;
	}

	function freshnessLabel(fetchedAt: number): string {
		const m = (Date.now() - fetchedAt) / 60_000;
		if (m < 1) return "now";
		if (m < 60) return `${Math.round(m)}m`;
		return `${Math.round(m / 60)}h`;
	}

	function freshnessDot(fetchedAt: number): string {
		const m = (Date.now() - fetchedAt) / 60_000;
		if (m < 10) return "bg-bio-green";
		if (m < 30) return "bg-warning-yellow";
		return "bg-claw-red";
	}
</script>

<svelte:head>
	<title>Economy & Market - SpaceMolt Commander</title>
</svelte:head>

<div class="space-y-4">
	<!-- Header with tabs -->
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold text-star-white">Economy & Market</h1>
		<div class="flex gap-1 bg-deep-void rounded-lg p-0.5">
			<button
				class="px-3 py-1 text-xs rounded-md transition-colors {activeTab === 'overview'
					? 'bg-plasma-cyan/20 text-plasma-cyan' : 'text-hull-grey hover:text-chrome-silver'}"
				onclick={() => activeTab = "overview"}>Overview</button>
			<button
				class="px-3 py-1 text-xs rounded-md transition-colors {activeTab === 'market'
					? 'bg-plasma-cyan/20 text-plasma-cyan' : 'text-hull-grey hover:text-chrome-silver'}"
				onclick={() => activeTab = "market"}>Market Prices</button>
		</div>
	</div>

	<!-- P&L Summary (always visible) -->
	<div class="grid grid-cols-2 md:grid-cols-4 gap-3">
		<div class="card p-3">
			<p class="text-[10px] text-chrome-silver uppercase tracking-wider">Revenue (24h)</p>
			<p class="text-xl font-bold mono text-bio-green mt-0.5">
				{$economy?.totalRevenue24h?.toLocaleString() ?? "---"}
			</p>
		</div>
		<div class="card p-3">
			<p class="text-[10px] text-chrome-silver uppercase tracking-wider">Costs (24h)</p>
			<p class="text-xl font-bold mono text-claw-red mt-0.5">
				{$economy?.totalCosts24h?.toLocaleString() ?? "---"}
			</p>
		</div>
		<div class="card p-3">
			<p class="text-[10px] text-chrome-silver uppercase tracking-wider">Net Profit (24h)</p>
			<p class="text-xl font-bold mono mt-0.5 {($economy?.netProfit24h ?? 0) >= 0 ? 'text-bio-green' : 'text-claw-red'}">
				{($economy?.netProfit24h ?? 0) >= 0 ? "+" : ""}{$economy?.netProfit24h?.toLocaleString() ?? "---"}
			</p>
		</div>
		<div class="card p-3">
			<p class="text-[10px] text-chrome-silver uppercase tracking-wider">Open Orders</p>
			<p class="text-xl font-bold mono text-star-white mt-0.5">
				{($economy?.openOrders?.length ?? 0)}
				<span class="text-xs font-normal text-hull-grey">
					({buyOrders.length}B / {sellOrders.length}S)
				</span>
			</p>
		</div>
	</div>

	{#if activeTab === "overview"}
		<!-- ═══ OVERVIEW TAB ═══ -->

		<!-- Supply Chain Flow -->
		<SupplyChainFlow />

		<!-- Buy Orders / Sell Orders side by side -->
		<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
			<!-- Buy Orders -->
			<div class="card p-4">
				<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-3">
					Buy Orders
					{#if buyOrders.length > 0}
						<span class="text-hull-grey font-normal ml-1">({buyOrders.length})</span>
					{/if}
				</h2>
				{#if buyOrders.length === 0}
					<p class="text-sm text-hull-grey py-6 text-center">No active buy orders</p>
				{:else}
					<div class="overflow-y-auto max-h-72">
						<table class="w-full text-xs">
							<thead class="sticky top-0 bg-deep-void">
								<tr class="text-left text-[10px] text-chrome-silver uppercase tracking-wider border-b border-hull-grey/30">
									<th class="pb-1.5 pr-2">Item</th>
									<th class="pb-1.5 pr-2 text-right">Qty</th>
									<th class="pb-1.5 pr-2 text-right">Price</th>
									<th class="pb-1.5 pr-2 text-right">Total</th>
									<th class="pb-1.5 pr-2 text-right">Fill</th>
									<th class="pb-1.5 pr-2">Owner</th>
									<th class="pb-1.5 text-right">Age</th>
								</tr>
							</thead>
							<tbody class="divide-y divide-hull-grey/10">
								{#each buyOrders as order}
									<tr class="hover:bg-nebula-blue/10 transition-colors">
										<td class="py-1.5 pr-2 text-star-white">{order.itemName}</td>
										<td class="py-1.5 pr-2 text-right mono text-chrome-silver">{order.quantity}</td>
										<td class="py-1.5 pr-2 text-right mono text-bio-green">{order.priceEach.toLocaleString()}</td>
										<td class="py-1.5 pr-2 text-right mono text-chrome-silver">{(order.total ?? order.priceEach * order.quantity).toLocaleString()}</td>
										<td class="py-1.5 pr-2 text-right">
											<div class="flex items-center justify-end gap-1">
												<div class="w-12 h-1.5 bg-hull-grey/20 rounded-full overflow-hidden">
													<div class="h-full bg-bio-green/60 rounded-full" style="width:{Math.round(order.filled / order.quantity * 100)}%"></div>
												</div>
												<span class="mono text-hull-grey text-[10px]">{order.filled}/{order.quantity}</span>
											</div>
										</td>
										<td class="py-1.5 pr-2 truncate max-w-[80px]">
											{#if order.owner === "faction"}
												<span class="text-[10px] px-1 py-0.5 rounded bg-void-purple/20 text-void-purple">Faction</span>
											{:else}
												<span class="text-laser-blue">{order.botId}</span>
											{/if}
										</td>
										<td class="py-1.5 text-right {orderAgeClass(order.createdAt)} text-[10px]">{orderAge(order.createdAt)}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			</div>

			<!-- Sell Orders -->
			<div class="card p-4">
				<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-3">
					Sell Orders
					{#if sellOrders.length > 0}
						<span class="text-hull-grey font-normal ml-1">({sellOrders.length})</span>
					{/if}
				</h2>
				{#if sellOrders.length === 0}
					<p class="text-sm text-hull-grey py-6 text-center">No active sell orders</p>
				{:else}
					<div class="overflow-y-auto max-h-72">
						<table class="w-full text-xs">
							<thead class="sticky top-0 bg-deep-void">
								<tr class="text-left text-[10px] text-chrome-silver uppercase tracking-wider border-b border-hull-grey/30">
									<th class="pb-1.5 pr-2">Item</th>
									<th class="pb-1.5 pr-2 text-right">Qty</th>
									<th class="pb-1.5 pr-2 text-right">Price</th>
									<th class="pb-1.5 pr-2 text-right">Total</th>
									<th class="pb-1.5 pr-2 text-right">Fill</th>
									<th class="pb-1.5 pr-2">Owner</th>
									<th class="pb-1.5 text-right">Age</th>
								</tr>
							</thead>
							<tbody class="divide-y divide-hull-grey/10">
								{#each sellOrders as order}
									<tr class="hover:bg-nebula-blue/10 transition-colors">
										<td class="py-1.5 pr-2 text-star-white">{order.itemName}</td>
										<td class="py-1.5 pr-2 text-right mono text-chrome-silver">{order.quantity}</td>
										<td class="py-1.5 pr-2 text-right mono text-shell-orange">{order.priceEach.toLocaleString()}</td>
										<td class="py-1.5 pr-2 text-right mono text-chrome-silver">{(order.total ?? order.priceEach * order.quantity).toLocaleString()}</td>
										<td class="py-1.5 pr-2 text-right">
											<div class="flex items-center justify-end gap-1">
												<div class="w-12 h-1.5 bg-hull-grey/20 rounded-full overflow-hidden">
													<div class="h-full bg-shell-orange/60 rounded-full" style="width:{Math.round(order.filled / order.quantity * 100)}%"></div>
												</div>
												<span class="mono text-hull-grey text-[10px]">{order.filled}/{order.quantity}</span>
											</div>
										</td>
										<td class="py-1.5 pr-2 truncate max-w-[80px]">
											{#if order.owner === "faction"}
												<span class="text-[10px] px-1 py-0.5 rounded bg-void-purple/20 text-void-purple">Faction</span>
											{:else}
												<span class="text-laser-blue">{order.botId}</span>
											{/if}
										</td>
										<td class="py-1.5 text-right {orderAgeClass(order.createdAt)} text-[10px]">{orderAge(order.createdAt)}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			</div>
		</div>

		<!-- Profit Chart -->
		<ProfitChart />

		<!-- Trade Activity -->
		<div class="card p-4">
			<div class="flex items-center justify-between mb-3">
				<div>
					<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider">
						Trade Activity
					</h2>
					{#if trades.length > 0}
						<p class="text-xs text-hull-grey mt-0.5">
							{tradeSummary.sellCount} sells
							<span class="text-bio-green">(+{tradeSummary.totalRevenue.toLocaleString()})</span>
							&middot;
							{tradeSummary.buyCount} buys
							<span class="text-claw-red">(-{tradeSummary.totalCosts.toLocaleString()})</span>
							&middot;
							Daily: <span class="{tradeSummary.netProfit >= 0 ? 'text-bio-green' : 'text-claw-red'} font-medium">
								{tradeSummary.netProfit >= 0 ? "+" : ""}{tradeSummary.netProfit.toLocaleString()} cr
							</span>
						</p>
					{/if}
				</div>
				<div class="flex gap-1">
					{#each TRADE_RANGES as r}
						<button
							class="px-2 py-0.5 text-xs rounded transition-colors {tradeRange === r.value
								? 'bg-plasma-cyan/20 text-plasma-cyan'
								: 'text-hull-grey hover:text-chrome-silver'}"
							onclick={() => tradeRange = r.value}
						>{r.label}</button>
					{/each}
				</div>
			</div>

			{#if trades.length === 0}
				<p class="text-sm text-hull-grey py-8 text-center">No trade activity recorded</p>
			{:else}
				<div class="overflow-x-auto max-h-80 overflow-y-auto">
					<table class="w-full text-xs">
						<thead class="sticky top-0 bg-deep-void">
							<tr class="text-left text-[10px] text-chrome-silver uppercase tracking-wider border-b border-hull-grey/30">
								<th class="pb-1.5 pr-3">Time</th>
								<th class="pb-1.5 pr-3">Bot</th>
								<th class="pb-1.5 pr-3">Action</th>
								<th class="pb-1.5 pr-3">Item</th>
								<th class="pb-1.5 pr-3 text-right">Qty</th>
								<th class="pb-1.5 pr-3 text-right">Price</th>
								<th class="pb-1.5 text-right">Total</th>
							</tr>
						</thead>
						<tbody class="divide-y divide-hull-grey/10">
							{#each trades as trade}
								<tr class="hover:bg-nebula-blue/10 transition-colors">
									<td class="py-1.5 pr-3 text-hull-grey mono whitespace-nowrap">{formatTime(trade.timestamp)}</td>
									<td class="py-1.5 pr-3 text-laser-blue">{trade.botId}</td>
									<td class="py-1.5 pr-3">
										<span class="font-medium px-1.5 py-0.5 rounded {trade.action === 'sell'
											? 'bg-bio-green/20 text-bio-green'
											: 'bg-shell-orange/20 text-shell-orange'}">
											{trade.action.toUpperCase()}
										</span>
									</td>
									<td class="py-1.5 pr-3 text-star-white">{formatItemName(trade.itemId)}</td>
									<td class="py-1.5 pr-3 text-right mono text-chrome-silver">{trade.quantity}</td>
									<td class="py-1.5 pr-3 text-right mono text-chrome-silver">{trade.priceEach.toLocaleString()}</td>
									<td class="py-1.5 text-right mono font-medium {trade.action === 'sell' ? 'text-bio-green' : 'text-claw-red'}">
										{trade.action === 'sell' ? '+' : '-'}{trade.total.toLocaleString()}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</div>

		<!-- Deficits / Surpluses -->
		<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
			<div class="card p-4">
				<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-3">Supply Deficits</h2>
				{#if !$economy?.deficits?.length}
					<p class="text-sm text-hull-grey py-4 text-center">No deficits — supply chain healthy</p>
				{:else}
					<div class="space-y-1.5">
						{#each $economy.deficits as d}
							<div class="flex items-center justify-between py-1.5 border-b border-hull-grey/15 last:border-0">
								<div class="flex items-center gap-2">
									<span class="text-star-white text-sm">{d.itemName}</span>
									<span class="text-[10px] px-1.5 py-0.5 rounded {d.priority === 'critical' ? 'bg-claw-red/20 text-claw-red' : d.priority === 'normal' ? 'bg-warning-yellow/20 text-warning-yellow' : 'bg-hull-grey/20 text-hull-grey'}">{d.priority}</span>
								</div>
								<div class="text-right text-xs">
									<span class="text-claw-red mono">-{d.shortfall}/hr</span>
									<span class="text-hull-grey ml-2">{d.supplyPerHour}/{d.demandPerHour}</span>
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</div>
			<div class="card p-4">
				<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-3">Surpluses</h2>
				{#if !$economy?.surpluses?.length}
					<p class="text-sm text-hull-grey py-4 text-center">No surpluses tracked</p>
				{:else}
					<div class="space-y-1.5">
						{#each $economy.surpluses as s}
							<div class="flex items-center justify-between py-1.5 border-b border-hull-grey/15 last:border-0">
								<div>
									<span class="text-star-white text-sm">{s.itemName}</span>
									<span class="text-xs text-hull-grey ml-2">@ {s.stationName}</span>
								</div>
								<div class="text-right text-xs">
									<span class="text-bio-green mono">+{s.excessPerHour}/hr</span>
									<span class="text-hull-grey ml-2">{s.currentStock} stock</span>
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</div>
		</div>

	{:else}
		<!-- ═══ MARKET PRICES TAB ═══ -->

		<!-- Quick stats -->
		<div class="grid grid-cols-3 gap-3">
			<div class="card p-3">
				<p class="text-[10px] text-chrome-silver uppercase tracking-wider">Tracked Items</p>
				<p class="text-xl font-bold mono text-star-white mt-0.5">{gridItems.length || "---"}</p>
			</div>
			<div class="card p-3">
				<p class="text-[10px] text-chrome-silver uppercase tracking-wider">Stations Scanned</p>
				<p class="text-xl font-bold mono text-star-white mt-0.5">{marketStationsData.length || "---"}</p>
			</div>
			<div class="card p-3">
				<p class="text-[10px] text-chrome-silver uppercase tracking-wider">Best Arbitrage</p>
				<p class="text-xl font-bold mono text-bio-green mt-0.5">
					{arbitrageOpps.length > 0 ? `${arbitrageOpps[0].profit.toLocaleString()} cr` : "---"}
				</p>
			</div>
		</div>

		<!-- Arbitrage routes -->
		{#if arbitrageOpps.length > 0}
			<div class="card p-4">
				<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-3">Top Arbitrage Routes</h2>
				<div class="grid gap-1.5">
					{#each arbitrageOpps as opp}
						<button
							class="flex items-center gap-3 px-3 py-2 rounded-lg bg-deep-void/50 border border-hull-grey/15 hover:border-plasma-cyan/30 transition-colors w-full text-left text-xs"
							onclick={() => { selectedItem = opp.itemId; }}
						>
							<span class="text-star-white font-medium min-w-[100px]">{opp.item}</span>
							<span class="text-plasma-cyan truncate">{opp.buyAt}</span>
							<span class="text-hull-grey mono">@{opp.buyPrice.toLocaleString()}</span>
							<span class="text-hull-grey">→</span>
							<span class="text-shell-orange truncate">{opp.sellAt}</span>
							<span class="text-hull-grey mono">@{opp.sellPrice.toLocaleString()}</span>
							<span class="ml-auto text-bio-green font-bold mono shrink-0">+{opp.profit.toLocaleString()}</span>
						</button>
					{/each}
				</div>
			</div>
		{/if}

		<!-- Price table -->
		{#if displayItems.length > 0}
			<div class="card p-4">
				<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-3">Price Overview</h2>
				<div class="overflow-y-auto max-h-[500px]">
					<table class="w-full text-xs border-collapse">
						<thead class="sticky top-0 bg-deep-void z-10">
							<tr class="text-left text-[10px] text-chrome-silver uppercase tracking-wider border-b border-hull-grey/30">
								<th class="pb-2 pr-3">
									<button class="hover:text-star-white transition-colors" onclick={() => toggleSort("name")}>Item{sortIcon("name")}</button>
								</th>
								<th class="pb-2 px-3 text-right">
									<button class="hover:text-star-white transition-colors" onclick={() => toggleSort("sell")}>Sell{sortIcon("sell")}</button>
								</th>
								<th class="pb-2 px-3 text-right">Sell Qty</th>
								<th class="pb-2 px-3 text-right">
									<button class="hover:text-star-white transition-colors" onclick={() => toggleSort("buy")}>Buy{sortIcon("buy")}</button>
								</th>
								<th class="pb-2 px-3 text-right">Buy Qty</th>
								<th class="pb-2 px-3 text-right">
									<button class="hover:text-star-white transition-colors" onclick={() => toggleSort("spread")}>Spread{sortIcon("spread")}</button>
								</th>
							</tr>
						</thead>
						<tbody class="divide-y divide-hull-grey/10">
							{#each displayItems as item (item.itemId)}
								<tr
									class="hover:bg-nebula-blue/10 transition-colors cursor-pointer {expandedItem === item.itemId ? 'bg-nebula-blue/15' : ''}"
									style={spreadBg(item.spread)}
									onclick={() => { expandedItem = expandedItem === item.itemId ? null : item.itemId; selectedItem = item.itemId; }}
								>
									<td class="py-1.5 pr-3 text-star-white font-medium">{item.itemName}</td>
									<td class="py-1.5 px-3 text-right mono {item.bestSell > 0 ? 'text-bio-green' : 'text-hull-grey/40'}">
										{item.bestSell > 0 ? item.bestSell.toLocaleString() : "-"}
									</td>
									<td class="py-1.5 px-3 text-right mono text-chrome-silver">
										{item.totalSellVolume > 0 ? item.totalSellVolume.toLocaleString() : "-"}
									</td>
									<td class="py-1.5 px-3 text-right mono {item.bestBuy > 0 ? 'text-claw-red' : 'text-hull-grey/40'}">
										{item.bestBuy > 0 ? item.bestBuy.toLocaleString() : "-"}
									</td>
									<td class="py-1.5 px-3 text-right mono text-chrome-silver">
										{item.totalBuyVolume > 0 ? item.totalBuyVolume.toLocaleString() : "-"}
									</td>
									<td class="py-1.5 px-3 text-right mono font-medium {item.spread > 0 ? 'text-bio-green' : 'text-hull-grey/40'}">
										{item.spread > 0 ? `+${item.spread.toLocaleString()}` : "-"}
									</td>
								</tr>
								{#if expandedItem === item.itemId}
									<tr>
										<td colspan="6" class="px-4 py-2 bg-nebula-blue/5 border-t border-hull-grey/10">
											<div class="grid gap-1">
												<div class="grid grid-cols-[1fr,70px,50px,70px,50px,50px] gap-2 text-[9px] text-hull-grey uppercase tracking-wider pb-1 border-b border-hull-grey/15">
													<span>Station</span><span class="text-right">Sell</span><span class="text-right">Qty</span>
													<span class="text-right">Buy</span><span class="text-right">Qty</span><span class="text-right">Age</span>
												</div>
												{#each item.stations as sp}
													<div class="grid grid-cols-[1fr,70px,50px,70px,50px,50px] gap-2 items-center text-[11px]">
														<div class="flex items-center gap-1">
															<span class="w-1.5 h-1.5 rounded-full shrink-0 {freshnessDot(sp.fetchedAt)}"></span>
															<span class="text-star-white truncate">{sp.stationName}</span>
														</div>
														<span class="text-right mono {sp.sellPrice === item.bestSell ? 'text-bio-green font-medium' : 'text-chrome-silver'}">
															{sp.sellPrice > 0 ? sp.sellPrice.toLocaleString() : "-"}
														</span>
														<span class="text-right mono text-hull-grey">{sp.sellVolume > 0 ? sp.sellVolume : "-"}</span>
														<span class="text-right mono {sp.buyPrice === item.bestBuy ? 'text-claw-red font-medium' : 'text-chrome-silver'}">
															{sp.buyPrice > 0 ? sp.buyPrice.toLocaleString() : "-"}
														</span>
														<span class="text-right mono text-hull-grey">{sp.buyVolume > 0 ? sp.buyVolume : "-"}</span>
														<span class="text-right mono text-hull-grey text-[9px]">{freshnessLabel(sp.fetchedAt)}</span>
													</div>
												{/each}
											</div>
										</td>
									</tr>
								{/if}
							{/each}
						</tbody>
					</table>
				</div>
			</div>
		{:else}
			<div class="card p-8 text-center text-hull-grey text-sm">
				No market data scanned yet. Bots scan prices automatically when docked.
			</div>
		{/if}

		<!-- Price history -->
		<div class="card p-4">
			<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-3">Price History</h2>
			<div class="h-56">
				<PriceHistory {selectedItem} onSelectItem={(item) => selectedItem = item} />
			</div>
		</div>
	{/if}
</div>
