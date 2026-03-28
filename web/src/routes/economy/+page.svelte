<script lang="ts">
	import { economy, bots, factionState } from "$stores/websocket";
	import Chart from "$lib/components/Chart.svelte";
	import SupplyChainFlow from "$lib/components/SupplyChainFlow.svelte";
	import PriceHistory from "$lib/components/PriceHistory.svelte";

	type TradeRange = "1h" | "1d" | "1w" | "all";
	type Tab = "overview" | "market";
	type TradeFilter = "all" | "buy" | "sell" | "craft";

	let activeTab = $state<Tab>("overview");
	let tradeRange = $state<TradeRange>("1d");
	let tradeFilter = $state<TradeFilter>("all");
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

	// Market data fetched from API
	let marketStationsData = $state<Array<{
		stationId: string;
		stationName: string;
		prices: Array<{ itemId: string; itemName: string; buyPrice: number; sellPrice: number; buyVolume: number; sellVolume: number }>;
		fetchedAt: number;
	}>>([]);

	// Financial chart data
	let botBreakdown = $state<Array<{ botId: string; revenue: number; cost: number }>>([]);
	let miningRate = $state<Array<{ hour: number; total: number; byBot: Record<string, number>; byOre: Record<string, number> }>>([]);
	let revenueHistory = $state<Array<{ timestamp: number; revenue: number; cost: number; profit: number }>>([]);
	let revenueHistoryRange = $state<TradeRange>("1d");

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

	async function fetchBotBreakdown() {
		try {
			const res = await fetch(`/api/economy/bot-breakdown?range=1d`);
			if (res.ok) botBreakdown = await res.json();
		} catch { /* silent */ }
	}

	async function fetchMiningRate() {
		try {
			const res = await fetch(`/api/economy/mining-rate?range=1d`);
			if (res.ok) miningRate = await res.json();
		} catch { /* silent */ }
	}

	async function fetchRevenueHistory(r: TradeRange) {
		try {
			const res = await fetch(`/api/economy/history?range=${r}`);
			if (res.ok) revenueHistory = await res.json();
		} catch { /* silent */ }
	}

	$effect(() => { fetchTrades(tradeRange); });
	$effect(() => {
		const interval = setInterval(() => fetchTrades(tradeRange), 15_000);
		return () => clearInterval(interval);
	});

	// Fetch financial charts data on overview tab
	$effect(() => {
		if (activeTab === "overview") {
			fetchBotBreakdown();
			fetchMiningRate();
			fetchRevenueHistory(revenueHistoryRange);
		}
	});
	$effect(() => {
		fetchRevenueHistory(revenueHistoryRange);
	});
	$effect(() => {
		if (activeTab !== "overview") return;
		const interval = setInterval(() => {
			fetchBotBreakdown();
			fetchMiningRate();
			fetchRevenueHistory(revenueHistoryRange);
		}, 30_000);
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
		if (!createdAt) return "\u2014";
		const age = Math.floor((Date.now() - new Date(createdAt).getTime()) / 60_000);
		if (age < 0) return "\u2014";
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
	const filteredTrades = $derived(
		tradeFilter === "all" ? trades : trades.filter(t => t.action === tradeFilter)
	);
	const tradeSummary = $derived.by(() => {
		let totalRevenue = 0, totalCosts = 0, sellCount = 0, buyCount = 0, craftCount = 0;
		for (const t of trades) {
			if (t.action === "sell") { totalRevenue += t.total; sellCount++; }
			else if (t.action === "buy") { totalCosts += t.total; buyCount++; }
			else if (t.action === "craft") { craftCount++; }
		}
		return { totalRevenue, totalCosts, netProfit: totalRevenue - totalCosts, sellCount, buyCount, craftCount };
	});

	// ── Fleet Treasury ──
	const roleGroups = $derived.by(() => {
		const groups = new Map<string, number>();
		for (const b of $bots) {
			const r = b.routine || b.role || 'idle';
			groups.set(r, (groups.get(r) ?? 0) + 1);
		}
		return groups;
	});

	// ── Key Metrics ──
	const activeMiners = $derived($bots.filter(b => b.status === "running" && b.routine === "miner").length);
	const activeCrafters = $derived($bots.filter(b => b.status === "running" && b.routine === "crafter").length);
	const activeTraders = $derived($bots.filter(b => b.status === "running" && (b.routine === "trader" || b.routine === "quartermaster")).length);

	// Ore per hour — total and by type
	const oreStats = $derived.by(() => {
		if (miningRate.length === 0) return { totalPerHour: 0, topOre: "", topOrePerHour: 0, oreTypes: [] as Array<{ ore: string; perHour: number }> };
		// Average over completed hours (skip current incomplete hour)
		const completed = miningRate.length > 1 ? miningRate.slice(0, -1) : miningRate;
		const totalPerHour = completed.length > 0
			? Math.round(completed.reduce((s, h) => s + h.total, 0) / completed.length)
			: 0;

		// Aggregate by ore type across all hours
		const oreTotals = new Map<string, number>();
		for (const h of completed) {
			if (!h.byOre) continue;
			for (const [ore, qty] of Object.entries(h.byOre)) {
				oreTotals.set(ore, (oreTotals.get(ore) ?? 0) + qty);
			}
		}
		const oreTypes = [...oreTotals.entries()]
			.map(([ore, total]) => ({ ore, perHour: Math.round(total / completed.length) }))
			.sort((a, b) => b.perHour - a.perHour);

		const topOre = oreTypes[0]?.ore ?? "";
		const topOrePerHour = oreTypes[0]?.perHour ?? 0;

		return { totalPerHour, topOre, topOrePerHour, oreTypes };
	});

	// Trade income from sells
	const tradeIncome = $derived.by(() => {
		let income = 0;
		for (const t of trades) {
			if (t.action === "sell") income += t.total;
		}
		return income;
	});

	// Faction storage ore count
	const factionOreCount = $derived.by(() => {
		const storage = $factionState?.storage ?? [];
		let total = 0;
		for (const s of storage) {
			if (s.itemId.startsWith("ore_") || s.itemId.endsWith("_ore")) total += s.quantity;
		}
		return total;
	});

	// ── Revenue vs Costs chart ──
	const revenueCostOption = $derived.by(() => {
		if (!revenueHistory || revenueHistory.length === 0) return null;

		const times: string[] = [];
		const revenueData: number[] = [];
		const costData: number[] = [];
		const profitData: number[] = [];

		for (const d of revenueHistory) {
			const t = new Date(d.timestamp);
			if (revenueHistoryRange === "1h" || revenueHistoryRange === "1d") {
				times.push(t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
			} else {
				times.push(t.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
			}
			revenueData.push(d.revenue);
			costData.push(d.cost);
			profitData.push(d.profit);
		}

		return {
			tooltip: {
				trigger: "axis",
				backgroundColor: "#0d1321ee",
				borderColor: "#3d5a6c",
				textStyle: { color: "#e8f4f8", fontSize: 12 },
				formatter: (params: any) => {
					const items = Array.isArray(params) ? params : [params];
					let html = `<b>${items[0]?.axisValue ?? ""}</b>`;
					for (const p of items) {
						const color = p.color ?? "#fff";
						html += `<br/><span style="color:${color}">${p.seriesName}:</span> ${p.value?.toLocaleString() ?? "---"} cr`;
					}
					return html;
				},
			},
			legend: {
				data: ["Revenue", "Costs", "Net Profit"],
				textStyle: { color: "#a8c5d6", fontSize: 11 },
				top: 0,
				right: 0,
			},
			xAxis: {
				type: "category",
				data: times,
				axisLine: { lineStyle: { color: "#3d5a6c" } },
				axisLabel: { color: "#a8c5d6", fontSize: 10, rotate: revenueHistoryRange === "1w" || revenueHistoryRange === "all" ? 30 : 0 },
				boundaryGap: true,
			},
			yAxis: {
				type: "value",
				axisLine: { show: false },
				splitLine: { lineStyle: { color: "#1a274444" } },
				axisLabel: {
					color: "#a8c5d6",
					fontSize: 10,
					formatter: (v: number) => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(0)}k` : `${v}`),
				},
			},
			series: [
				{
					name: "Revenue",
					type: "bar",
					stack: "financial",
					data: revenueData,
					itemStyle: { color: "rgba(74, 222, 128, 0.7)" },
					emphasis: { itemStyle: { color: "#4ade80" } },
				},
				{
					name: "Costs",
					type: "bar",
					stack: "financial",
					data: costData.map(v => -v),
					itemStyle: { color: "rgba(248, 113, 113, 0.7)" },
					emphasis: { itemStyle: { color: "#f87171" } },
				},
				{
					name: "Net Profit",
					type: "line",
					data: profitData,
					smooth: true,
					showSymbol: false,
					lineStyle: { color: "#00d4ff", width: 2.5 },
					z: 10,
				},
			],
			grid: { left: 8, right: 8, top: 36, bottom: 8 },
		} as any;
	});

	// ── Bot Breakdown chart ──
	const botBreakdownOption = $derived.by(() => {
		if (!botBreakdown || botBreakdown.length === 0) return null;

		const sorted = [...botBreakdown].sort((a, b) => (b.revenue - b.cost) - (a.revenue - a.cost));
		const top = sorted.slice(0, 15);

		return {
			tooltip: {
				trigger: "axis",
				backgroundColor: "#0d1321ee",
				borderColor: "#3d5a6c",
				textStyle: { color: "#e8f4f8", fontSize: 12 },
				axisPointer: { type: "shadow" },
				formatter: (params: any) => {
					const items = Array.isArray(params) ? params : [params];
					const botName = items[0]?.axisValue ?? "";
					const rev = items.find((p: any) => p.seriesName === "Revenue");
					const cost = items.find((p: any) => p.seriesName === "Costs");
					const r = rev?.value ?? 0;
					const c = Math.abs(cost?.value ?? 0);
					return `<b>${botName}</b><br/><span style="color:#4ade80">Revenue:</span> ${r.toLocaleString()} cr<br/><span style="color:#f87171">Costs:</span> ${c.toLocaleString()} cr<br/><span style="color:#00d4ff">Profit:</span> ${(r - c).toLocaleString()} cr`;
				},
			},
			legend: {
				data: ["Revenue", "Costs"],
				textStyle: { color: "#a8c5d6", fontSize: 11 },
				top: 0,
				right: 0,
			},
			xAxis: {
				type: "value",
				axisLine: { show: false },
				splitLine: { lineStyle: { color: "#1a274444" } },
				axisLabel: {
					color: "#a8c5d6",
					fontSize: 10,
					formatter: (v: number) => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(0)}k` : `${v}`),
				},
			},
			yAxis: {
				type: "category",
				data: top.map(b => b.botId),
				axisLine: { lineStyle: { color: "#3d5a6c" } },
				axisLabel: { color: "#a8c5d6", fontSize: 10, width: 80, overflow: "truncate" },
				inverse: true,
			},
			series: [
				{
					name: "Revenue",
					type: "bar",
					stack: "total",
					data: top.map(b => b.revenue),
					itemStyle: { color: "rgba(74, 222, 128, 0.75)", borderRadius: [0, 2, 2, 0] },
				},
				{
					name: "Costs",
					type: "bar",
					stack: "total",
					data: top.map(b => -b.cost),
					itemStyle: { color: "rgba(248, 113, 113, 0.75)", borderRadius: [2, 0, 0, 2] },
				},
			],
			grid: { left: 8, right: 16, top: 36, bottom: 8 },
		} as any;
	});

	// ── Mining Rate chart — by ore type (stacked area) ──
	const miningRateOption = $derived.by(() => {
		if (!miningRate || miningRate.length === 0) return null;

		const times = miningRate.map(d => {
			const t = new Date(d.hour);
			return t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
		});

		// Collect all ore types across all hours
		const allOres = new Set<string>();
		for (const d of miningRate) {
			if (d.byOre) {
				for (const ore of Object.keys(d.byOre)) allOres.add(ore);
			}
		}

		// Color palette for ore types
		const oreColors: Record<string, string> = {
			iron_ore: "#b0b0b0",
			copper_ore: "#f59e0b",
			nickel_ore: "#94a3b8",
			titanium_ore: "#a78bfa",
			silicon_ore: "#38bdf8",
			carbon_ore: "#6b7280",
			gold_ore: "#fbbf24",
			platinum_ore: "#e2e8f0",
			vanadium_ore: "#34d399",
			sol_alloy_ore: "#ffd700",
			uranium_ore: "#22d3ee",
			lead_ore: "#9ca3af",
			radium_ore: "#e879f9",
			palladium_ore: "#fb923c",
			trade_crystal: "#00d4ff",
		};
		const defaultColors = ["#4ade80", "#f87171", "#a78bfa", "#fb923c", "#38bdf8", "#e879f9", "#fbbf24", "#34d399"];

		const oreList = [...allOres].sort((a, b) => {
			// Sort by total volume desc so the biggest ore is at the bottom of the stack
			const totalA = miningRate.reduce((s, d) => s + (d.byOre?.[a] ?? 0), 0);
			const totalB = miningRate.reduce((s, d) => s + (d.byOre?.[b] ?? 0), 0);
			return totalB - totalA;
		});

		const series: any[] = [];
		if (allOres.size > 0 && allOres.size <= 12) {
			// Stacked area per ore type
			oreList.forEach((ore, i) => {
				const color = oreColors[ore] ?? defaultColors[i % defaultColors.length];
				const label = ore.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
				series.push({
					name: label,
					type: "line",
					stack: "mining",
					smooth: true,
					showSymbol: false,
					areaStyle: { opacity: 0.5 },
					lineStyle: { width: 1, color },
					itemStyle: { color },
					data: miningRate.map(d => d.byOre?.[ore] ?? 0),
				});
			});
		} else {
			// Fallback: just total (no byOre data or too many types)
			series.push({
				name: "Total Ore",
				type: "line",
				smooth: true,
				showSymbol: false,
				lineStyle: { color: "#4ade80", width: 2 },
				areaStyle: {
					color: {
						type: "linear",
						x: 0, y: 0, x2: 0, y2: 1,
						colorStops: [
							{ offset: 0, color: "rgba(74, 222, 128, 0.3)" },
							{ offset: 1, color: "rgba(74, 222, 128, 0.02)" },
						],
					},
				},
				data: miningRate.map(d => d.total),
			});
		}

		return {
			tooltip: {
				trigger: "axis",
				backgroundColor: "#0d1321ee",
				borderColor: "#3d5a6c",
				textStyle: { color: "#e8f4f8", fontSize: 11 },
			},
			legend: allOres.size > 0 && allOres.size <= 12 ? {
				data: oreList.map(o => o.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())),
				textStyle: { color: "#a8c5d6", fontSize: 10 },
				top: 0,
				right: 0,
				type: "scroll",
			} : undefined,
			xAxis: {
				type: "category",
				data: times,
				axisLine: { lineStyle: { color: "#3d5a6c" } },
				axisLabel: { color: "#a8c5d6", fontSize: 10 },
				boundaryGap: false,
			},
			yAxis: {
				type: "value",
				name: "units/hr",
				nameTextStyle: { color: "#6b7f8e", fontSize: 10 },
				axisLine: { show: false },
				splitLine: { lineStyle: { color: "#1a274444" } },
				axisLabel: { color: "#a8c5d6", fontSize: 10 },
			},
			series,
			grid: { left: 8, right: 8, top: 36, bottom: 8 },
		} as any;
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

	function formatCredits(v: number): string {
		if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
		if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
		return v.toLocaleString();
	}

	function toggleSort(col: typeof sortBy) {
		if (sortBy === col) sortDir = sortDir === "asc" ? "desc" : "asc";
		else { sortBy = col; sortDir = col === "name" ? "asc" : "desc"; }
	}

	function sortIcon(col: typeof sortBy): string {
		if (sortBy !== col) return "";
		return sortDir === "asc" ? " \u25B2" : " \u25BC";
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

	<!-- Key Metrics Summary Cards -->
	<div class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3">
		<div class="card p-3">
			<p class="text-[10px] text-chrome-silver uppercase tracking-wider">Revenue (24h)</p>
			<p class="text-lg font-bold mono text-bio-green mt-0.5">
				{$economy?.totalRevenue24h ? formatCredits($economy.totalRevenue24h) : "---"}
			</p>
		</div>
		<div class="card p-3">
			<p class="text-[10px] text-chrome-silver uppercase tracking-wider">Costs (24h)</p>
			<p class="text-lg font-bold mono text-claw-red mt-0.5">
				{$economy?.totalCosts24h ? formatCredits($economy.totalCosts24h) : "---"}
			</p>
		</div>
		<div class="card p-3">
			<p class="text-[10px] text-chrome-silver uppercase tracking-wider">Net Profit</p>
			<p class="text-lg font-bold mono mt-0.5 {($economy?.netProfit24h ?? 0) >= 0 ? 'text-bio-green' : 'text-claw-red'}">
				{($economy?.netProfit24h ?? 0) >= 0 ? "+" : ""}{$economy?.netProfit24h ? formatCredits($economy.netProfit24h) : "---"}
			</p>
		</div>
		<div class="card p-3">
			<p class="text-[10px] text-chrome-silver uppercase tracking-wider">Trade Income</p>
			<p class="text-lg font-bold mono text-bio-green mt-0.5">
				{tradeIncome > 0 ? formatCredits(tradeIncome) : "---"}
			</p>
		</div>
		<div class="card p-3">
			<p class="text-[10px] text-chrome-silver uppercase tracking-wider">Ore/hr</p>
			<p class="text-lg font-bold mono text-shell-orange mt-0.5">
				{oreStats.totalPerHour > 0 ? oreStats.totalPerHour.toLocaleString() : "---"}
			</p>
			{#if oreStats.topOre}
				<p class="text-[9px] text-hull-grey mt-0.5 truncate">{formatItemName(oreStats.topOre)} {oreStats.topOrePerHour}/hr</p>
			{/if}
		</div>
		<div class="card p-3">
			<p class="text-[10px] text-chrome-silver uppercase tracking-wider">Fleet</p>
			<p class="text-lg font-bold mono mt-0.5">
				<span class="text-shell-orange">{activeMiners}</span><span class="text-hull-grey text-xs">M</span>
				<span class="text-void-purple ml-1">{activeCrafters}</span><span class="text-hull-grey text-xs">C</span>
				<span class="text-bio-green ml-1">{activeTraders}</span><span class="text-hull-grey text-xs">T</span>
			</p>
		</div>
		<div class="card p-3">
			<p class="text-[10px] text-chrome-silver uppercase tracking-wider">Faction Ore</p>
			<p class="text-lg font-bold mono text-star-white mt-0.5">
				{factionOreCount > 0 ? factionOreCount.toLocaleString() : "---"}
			</p>
		</div>
		<div class="card p-3">
			<p class="text-[10px] text-chrome-silver uppercase tracking-wider">Orders</p>
			<p class="text-lg font-bold mono text-star-white mt-0.5">
				{($economy?.openOrders?.length ?? 0)}
				<span class="text-[10px] font-normal text-hull-grey">
					{buyOrders.length}B/{sellOrders.length}S
				</span>
			</p>
		</div>
	</div>

	{#if activeTab === "overview"}
		<!-- Fleet Treasury Overview -->
		{@const totalBotCredits = $bots.reduce((s, b) => s + (b.credits || 0), 0)}
		{@const factionCredits = $factionState?.credits ?? 0}
		{@const totalAssets = totalBotCredits + factionCredits}
		{@const factionOre = ($factionState?.storage ?? []).filter(s => s.itemId.endsWith('_ore') || s.itemId === 'quantum_fragments').reduce((s, i) => s + i.quantity, 0)}
		{@const factionCrafted = ($factionState?.storage ?? []).filter(s => !s.itemId.endsWith('_ore') && s.itemId !== 'quantum_fragments' && !['water_ice','argon_gas','compressed_hydrogen','liquid_hydrogen','liquid_nitrogen','nitrogen_ice','purified_argon','purified_water'].includes(s.itemId)).reduce((s, i) => s + i.quantity, 0)}
		{@const factionGas = ($factionState?.storage ?? []).filter(s => ['water_ice','argon_gas','compressed_hydrogen','liquid_hydrogen','liquid_nitrogen','nitrogen_ice','purified_argon','purified_water'].includes(s.itemId)).reduce((s, i) => s + i.quantity, 0)}
		{@const activeBots = $bots.filter(b => b.status === 'running').length}
		{@const totalBots = $bots.length}
		<div class="card p-4 mb-4 border border-plasma-cyan/20">
			<div class="flex items-center justify-between mb-3">
				<h2 class="text-sm font-semibold text-plasma-cyan uppercase tracking-wider">Fleet Treasury</h2>
				<span class="text-xs text-hull-grey">{activeBots}/{totalBots} bots active</span>
			</div>
			<div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
				<div class="bg-hull-grey/10 rounded p-3">
					<div class="text-[10px] text-hull-grey uppercase">Total Assets</div>
					<div class="text-xl font-bold text-star-white">{formatCredits(totalAssets)}</div>
				</div>
				<div class="bg-hull-grey/10 rounded p-3">
					<div class="text-[10px] text-hull-grey uppercase">Faction Treasury</div>
					<div class="text-xl font-bold text-bio-green">{formatCredits(factionCredits)}</div>
				</div>
				<div class="bg-hull-grey/10 rounded p-3">
					<div class="text-[10px] text-hull-grey uppercase">Bot Wallets</div>
					<div class="text-xl font-bold text-star-white">{formatCredits(totalBotCredits)}</div>
					<div class="text-[9px] text-hull-grey mt-0.5">{formatCredits(totalBotCredits / Math.max(1, totalBots))}/bot avg</div>
				</div>
				<div class="bg-hull-grey/10 rounded p-3">
					<div class="text-[10px] text-hull-grey uppercase">Ore Stockpile</div>
					<div class="text-xl font-bold text-shell-orange">{factionOre > 0 ? factionOre.toLocaleString() : '---'}</div>
				</div>
				<div class="bg-hull-grey/10 rounded p-3">
					<div class="text-[10px] text-hull-grey uppercase">Crafted Goods</div>
					<div class="text-xl font-bold text-void-purple">{factionCrafted > 0 ? factionCrafted.toLocaleString() : '---'}</div>
				</div>
				<div class="bg-hull-grey/10 rounded p-3">
					<div class="text-[10px] text-hull-grey uppercase">Gas/Ice Stock</div>
					<div class="text-xl font-bold text-nebula-blue">{factionGas > 0 ? factionGas.toLocaleString() : '---'}</div>
				</div>
			</div>
			<!-- Bot role breakdown bar -->
			<div class="mt-3 flex gap-1 h-2 rounded-full overflow-hidden bg-hull-grey/10">
				{#each [...roleGroups.entries()].sort((a,b) => b[1] - a[1]) as [role, count]}
					{@const colors = { miner: 'bg-shell-orange', crafter: 'bg-void-purple', trader: 'bg-bio-green', quartermaster: 'bg-bio-green/70', explorer: 'bg-nebula-blue', scout: 'bg-plasma-cyan', harvester: 'bg-warning-yellow', return_home: 'bg-hull-grey', idle: 'bg-hull-grey/50' } as Record<string, string>}
					<div class="{colors[role] || 'bg-hull-grey'} transition-all" style="width:{count / Math.max(1, totalBots) * 100}%" title="{role}: {count}"></div>
				{/each}
			</div>
			<div class="mt-1 flex gap-3 flex-wrap">
				{#each [...roleGroups.entries()].sort((a,b) => b[1] - a[1]) as [role, count]}
					{@const colors = { miner: 'text-shell-orange', crafter: 'text-void-purple', trader: 'text-bio-green', quartermaster: 'text-bio-green/70', explorer: 'text-nebula-blue', scout: 'text-plasma-cyan', harvester: 'text-warning-yellow' } as Record<string, string>}
					<span class="text-[10px] {colors[role] || 'text-hull-grey'}">{count}x {role}</span>
				{/each}
			</div>
		</div>

		<!-- Revenue vs Costs Chart (primary financial view) -->
		<div class="card p-4">
			<div class="flex items-center justify-between mb-2">
				<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider">
					Revenue vs Costs
				</h2>
				<div class="flex gap-1">
					{#each TRADE_RANGES as r}
						<button
							class="px-2 py-0.5 text-xs rounded transition-colors {revenueHistoryRange === r.value
								? 'bg-plasma-cyan/20 text-plasma-cyan'
								: 'text-hull-grey hover:text-chrome-silver'}"
							onclick={() => revenueHistoryRange = r.value}
						>
							{r.label}
						</button>
					{/each}
				</div>
			</div>
			{#if revenueCostOption}
				<div class="h-56">
					<Chart option={revenueCostOption} />
				</div>
			{:else}
				<div class="h-56 flex items-center justify-center text-hull-grey text-sm">
					Collecting financial data...
				</div>
			{/if}
		</div>

		<!-- Mining by Ore Type + Per-Bot Revenue side by side -->
		<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
			<!-- Ore Mining Rate by Type -->
			<div class="card p-4">
				<div class="flex items-center justify-between mb-2">
					<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider">
						Mining by Ore Type (24h)
					</h2>
					{#if oreStats.oreTypes.length > 0}
						<span class="text-[10px] text-hull-grey">{oreStats.totalPerHour}/hr total</span>
					{/if}
				</div>
				{#if miningRateOption}
					<div class="h-64">
						<Chart option={miningRateOption} />
					</div>
					<!-- Ore breakdown pills -->
					{#if oreStats.oreTypes.length > 0}
						<div class="flex flex-wrap gap-1.5 mt-2">
							{#each oreStats.oreTypes.slice(0, 6) as ore}
								<span class="text-[10px] px-1.5 py-0.5 rounded bg-hull-grey/10 text-chrome-silver">
									{formatItemName(ore.ore)} <span class="text-star-white font-medium">{ore.perHour}/hr</span>
								</span>
							{/each}
						</div>
					{/if}
				{:else}
					<div class="h-64 flex items-center justify-center text-hull-grey text-sm">
						No mining data yet...
					</div>
				{/if}
			</div>

			<!-- Per-Bot Revenue Breakdown -->
			<div class="card p-4">
				<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-2">
					Per-Bot Revenue (24h)
				</h2>
				{#if botBreakdownOption}
					<div class="h-64">
						<Chart option={botBreakdownOption} />
					</div>
				{:else}
					<div class="h-64 flex items-center justify-center text-hull-grey text-sm">
						No per-bot data yet...
					</div>
				{/if}
			</div>
		</div>

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
					<div class="overflow-y-auto max-h-64">
						<table class="w-full text-xs">
							<thead class="sticky top-0 bg-deep-void">
								<tr class="text-left text-[10px] text-chrome-silver uppercase tracking-wider border-b border-hull-grey/30">
									<th class="pb-1.5 pr-2">Item</th>
									<th class="pb-1.5 pr-2 text-right">Qty</th>
									<th class="pb-1.5 pr-2 text-right">Price</th>
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
										<td class="py-1.5 pr-2 text-right">
											<div class="flex items-center justify-end gap-1">
												<div class="w-10 h-1.5 bg-hull-grey/20 rounded-full overflow-hidden">
													<div class="h-full bg-bio-green/60 rounded-full" style="width:{Math.round(order.filled / order.quantity * 100)}%"></div>
												</div>
												<span class="mono text-hull-grey text-[10px]">{order.filled}/{order.quantity}</span>
											</div>
										</td>
										<td class="py-1.5 pr-2 truncate max-w-[70px]">
											{#if order.owner === "faction"}
												<span class="text-[10px] px-1 py-0.5 rounded bg-void-purple/20 text-void-purple">Fac</span>
											{:else}
												<span class="text-laser-blue text-[10px]">{order.botId}</span>
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
					<div class="overflow-y-auto max-h-64">
						<table class="w-full text-xs">
							<thead class="sticky top-0 bg-deep-void">
								<tr class="text-left text-[10px] text-chrome-silver uppercase tracking-wider border-b border-hull-grey/30">
									<th class="pb-1.5 pr-2">Item</th>
									<th class="pb-1.5 pr-2 text-right">Qty</th>
									<th class="pb-1.5 pr-2 text-right">Price</th>
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
										<td class="py-1.5 pr-2 text-right">
											<div class="flex items-center justify-end gap-1">
												<div class="w-10 h-1.5 bg-hull-grey/20 rounded-full overflow-hidden">
													<div class="h-full bg-shell-orange/60 rounded-full" style="width:{Math.round(order.filled / order.quantity * 100)}%"></div>
												</div>
												<span class="mono text-hull-grey text-[10px]">{order.filled}/{order.quantity}</span>
											</div>
										</td>
										<td class="py-1.5 pr-2 truncate max-w-[70px]">
											{#if order.owner === "faction"}
												<span class="text-[10px] px-1 py-0.5 rounded bg-void-purple/20 text-void-purple">Fac</span>
											{:else}
												<span class="text-laser-blue text-[10px]">{order.botId}</span>
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

		<!-- Order Performance Summary -->
		{@const allOrders = $economy?.openOrders ?? []}
		{@const filledBuys = allOrders.filter(o => o.type === "buy" && o.filled > 0)}
		{@const filledSells = allOrders.filter(o => o.type === "sell" && o.filled > 0)}
		{@const completedBuyCost = filledBuys.reduce((s, o) => s + o.priceEach * o.filled, 0)}
		{@const completedSellRev = filledSells.reduce((s, o) => s + o.priceEach * o.filled, 0)}
		{@const activeBuyValue = buyOrders.reduce((s, o) => s + o.priceEach * (o.quantity - o.filled), 0)}
		{@const activeSellValue = sellOrders.reduce((s, o) => s + o.priceEach * (o.quantity - o.filled), 0)}
		{@const orderProfit = completedSellRev - completedBuyCost}
		{@const totalFillRate = allOrders.length > 0 ? allOrders.reduce((s, o) => s + (o.quantity > 0 ? o.filled / o.quantity : 0), 0) / allOrders.length * 100 : 0}
		<div class="card p-4">
			<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-3">
				Order Performance
			</h2>
			<div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
				<div class="bg-hull-grey/10 rounded p-2.5">
					<div class="text-[10px] text-hull-grey uppercase">Active Buy Orders</div>
					<div class="text-lg font-bold text-star-white">{buyOrders.length}</div>
					<div class="text-[10px] text-hull-grey">{activeBuyValue.toLocaleString()} cr escrowed</div>
				</div>
				<div class="bg-hull-grey/10 rounded p-2.5">
					<div class="text-[10px] text-hull-grey uppercase">Active Sell Orders</div>
					<div class="text-lg font-bold text-star-white">{sellOrders.length}</div>
					<div class="text-[10px] text-hull-grey">{activeSellValue.toLocaleString()} cr listed</div>
				</div>
				<div class="bg-hull-grey/10 rounded p-2.5">
					<div class="text-[10px] text-hull-grey uppercase">Filled Revenue</div>
					<div class="text-lg font-bold text-bio-green">{completedSellRev.toLocaleString()}</div>
					<div class="text-[10px] text-hull-grey">{filledSells.length} sell orders filled</div>
				</div>
				<div class="bg-hull-grey/10 rounded p-2.5">
					<div class="text-[10px] text-hull-grey uppercase">Order Profit</div>
					<div class="text-lg font-bold {orderProfit >= 0 ? 'text-bio-green' : 'text-claw-red'}">
						{orderProfit >= 0 ? "+" : ""}{orderProfit.toLocaleString()}
					</div>
					<div class="text-[10px] text-hull-grey">Fill rate: {totalFillRate.toFixed(0)}%</div>
				</div>
			</div>
			<!-- Filled orders detail table -->
			{#if filledSells.length > 0 || filledBuys.length > 0}
				<div class="overflow-y-auto max-h-48">
					<table class="w-full text-xs">
						<thead class="sticky top-0 bg-deep-void">
							<tr class="text-left text-[10px] text-chrome-silver uppercase tracking-wider border-b border-hull-grey/30">
								<th class="pb-1.5 pr-2">Item</th>
								<th class="pb-1.5 pr-2 text-right">Type</th>
								<th class="pb-1.5 pr-2 text-right">Filled</th>
								<th class="pb-1.5 pr-2 text-right">Price</th>
								<th class="pb-1.5 pr-2 text-right">Revenue</th>
								<th class="pb-1.5 text-right">Fill %</th>
							</tr>
						</thead>
						<tbody class="divide-y divide-hull-grey/10">
							{#each [...filledSells, ...filledBuys].sort((a, b) => b.priceEach * b.filled - a.priceEach * a.filled) as order}
								<tr class="hover:bg-nebula-blue/10 transition-colors">
									<td class="py-1.5 pr-2 text-star-white">{order.itemName || order.itemId}</td>
									<td class="py-1.5 pr-2 text-right">
										<span class="px-1 rounded text-[10px] {order.type === 'sell' ? 'bg-bio-green/20 text-bio-green' : 'bg-nebula-blue/20 text-nebula-blue'}">
											{order.type}
										</span>
									</td>
									<td class="py-1.5 pr-2 text-right text-star-white">{order.filled}/{order.quantity}</td>
									<td class="py-1.5 pr-2 text-right text-hull-grey">{order.priceEach.toLocaleString()}</td>
									<td class="py-1.5 pr-2 text-right {order.type === 'sell' ? 'text-bio-green' : 'text-claw-red'}">
										{(order.priceEach * order.filled).toLocaleString()}
									</td>
									<td class="py-1.5 text-right">
										<div class="flex items-center justify-end gap-1">
											<span class="text-hull-grey">{Math.round(order.filled / order.quantity * 100)}%</span>
											<div class="w-10 h-1.5 bg-hull-grey/20 rounded-full overflow-hidden">
												<div class="h-full bg-bio-green/60 rounded-full" style="width:{Math.round(order.filled / order.quantity * 100)}%"></div>
											</div>
										</div>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{:else}
				<p class="text-sm text-hull-grey text-center py-3">No filled orders yet</p>
			{/if}
		</div>

		<!-- Trade Activity -->
		<div class="card p-4">
			<div class="flex items-center justify-between mb-3">
				<div>
					<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider">
						Trade & Craft Activity
					</h2>
					{#if trades.length > 0}
						<p class="text-xs text-hull-grey mt-0.5">
							{tradeSummary.sellCount} sells
							<span class="text-bio-green">(+{tradeSummary.totalRevenue.toLocaleString()})</span>
							&middot;
							{tradeSummary.buyCount} buys
							<span class="text-claw-red">(-{tradeSummary.totalCosts.toLocaleString()})</span>
							{#if tradeSummary.craftCount > 0}
								&middot;
								{tradeSummary.craftCount} crafts
							{/if}
							&middot;
							Net: <span class="{tradeSummary.netProfit >= 0 ? 'text-bio-green' : 'text-claw-red'} font-medium">
								{tradeSummary.netProfit >= 0 ? "+" : ""}{tradeSummary.netProfit.toLocaleString()} cr
							</span>
						</p>
					{/if}
				</div>
				<div class="flex gap-2">
					<div class="flex gap-0.5">
						{#each [{ label: "All", value: "all" }, { label: "Buy", value: "buy" }, { label: "Sell", value: "sell" }, { label: "Craft", value: "craft" }] as f}
							<button
								class="px-2 py-0.5 text-xs rounded transition-colors {tradeFilter === f.value
									? 'bg-void-purple/20 text-void-purple'
									: 'text-hull-grey hover:text-chrome-silver'}"
								onclick={() => tradeFilter = f.value as TradeFilter}
							>{f.label}</button>
						{/each}
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
			</div>

			{#if filteredTrades.length === 0}
				<p class="text-sm text-hull-grey py-8 text-center">No {tradeFilter === 'all' ? 'trade' : tradeFilter} activity recorded</p>
			{:else}
				<div class="overflow-x-auto max-h-72 overflow-y-auto">
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
							{#each filteredTrades as trade}
								<tr class="hover:bg-nebula-blue/10 transition-colors">
									<td class="py-1.5 pr-3 text-hull-grey mono whitespace-nowrap">{formatTime(trade.timestamp)}</td>
									<td class="py-1.5 pr-3 text-laser-blue">{trade.botId}</td>
									<td class="py-1.5 pr-3">
										<span class="font-medium px-1.5 py-0.5 rounded {trade.action === 'sell'
											? 'bg-bio-green/20 text-bio-green'
											: trade.action === 'craft'
												? 'bg-void-purple/20 text-void-purple'
												: 'bg-shell-orange/20 text-shell-orange'}">
											{trade.action.toUpperCase()}
										</span>
									</td>
									<td class="py-1.5 pr-3 text-star-white">{formatItemName(trade.itemId)}</td>
									<td class="py-1.5 pr-3 text-right mono text-chrome-silver">{trade.quantity}</td>
									<td class="py-1.5 pr-3 text-right mono text-chrome-silver">
										{trade.action === 'craft' ? '---' : trade.priceEach.toLocaleString()}
									</td>
									<td class="py-1.5 text-right mono font-medium {trade.action === 'sell' ? 'text-bio-green' : trade.action === 'craft' ? 'text-void-purple' : 'text-claw-red'}">
										{#if trade.action === 'craft'}
											+{trade.quantity}
										{:else}
											{trade.action === 'sell' ? '+' : '-'}{trade.total.toLocaleString()}
										{/if}
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
					<p class="text-sm text-hull-grey py-4 text-center">No deficits -- supply chain healthy</p>
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
		<!-- MARKET PRICES TAB -->

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
							<span class="text-hull-grey">&rarr;</span>
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
