<script lang="ts">
	import { bots, economy, factionState } from "$stores/websocket";

	// Count running bots per routine
	const routineCounts = $derived.by(() => {
		const counts = new Map<string, number>();
		for (const b of $bots) {
			if (b.status !== "running" || !b.routine) continue;
			counts.set(b.routine, (counts.get(b.routine) ?? 0) + 1);
		}
		return counts;
	});

	// Faction storage aggregates
	const storageAggregates = $derived.by(() => {
		const storage = $factionState?.storage ?? [];
		let ores = 0, goods = 0, modules = 0;
		for (const s of storage) {
			if (s.itemId.startsWith("ore_")) ores += s.quantity;
			else if (s.itemId.includes("harvester") || s.itemId.includes("scanner") || s.itemId.includes("laser") || s.itemId.includes("weapon") || s.itemId.includes("shield") || s.itemId.includes("engine")) modules += s.quantity;
			else goods += s.quantity;
		}
		return { ores, goods, modules };
	});

	const revenue = $derived($economy?.totalRevenue24h ?? 0);

	// Supply chain with all routine types
	interface FlowStage {
		label: string;
		items: { name: string; count: number; color: string }[];
		type: "routine" | "storage" | "output";
	}

	const stages = $derived.by((): FlowStage[] => {
		const rc = routineCounts;
		return [
			{
				label: "Extraction",
				type: "routine",
				items: [
					{ name: "Miners", count: rc.get("miner") ?? 0, color: "#ff6b35" },
					{ name: "Harvesters", count: rc.get("harvester") ?? 0, color: "#ff6b35" },
					{ name: "Salvagers", count: rc.get("salvager") ?? 0, color: "#eab308" },
					{ name: "Scavengers", count: rc.get("scavenger") ?? 0, color: "#a3a3a3" },
				].filter(i => i.count > 0),
			},
			{
				label: "Faction Storage",
				type: "storage",
				items: [
					{ name: "Ores", count: storageAggregates.ores, color: "#a8c5d6" },
					{ name: "Goods", count: storageAggregates.goods, color: "#c084fc" },
					{ name: "Modules", count: storageAggregates.modules, color: "#60a5fa" },
				].filter(i => i.count > 0),
			},
			{
				label: "Processing",
				type: "routine",
				items: [
					{ name: "Crafters", count: rc.get("crafter") ?? 0, color: "#9b59b6" },
					{ name: "Refitters", count: rc.get("refit") ?? 0, color: "#7b68ee" },
				].filter(i => i.count > 0),
			},
			{
				label: "Distribution",
				type: "routine",
				items: [
					{ name: "Traders", count: rc.get("trader") ?? 0, color: "#2dd4bf" },
					{ name: "QM", count: rc.get("quartermaster") ?? 0, color: "#14b8a6" },
				].filter(i => i.count > 0),
			},
			{
				label: "Revenue",
				type: "output",
				items: [
					{ name: "Credits/24h", count: revenue, color: "#ffd700" },
				],
			},
		];
	});

	// Support routines (shown separately below)
	const supportRoutines = $derived.by(() => {
		const rc = routineCounts;
		return [
			{ name: "Explorers", count: rc.get("explorer") ?? 0, color: "#22d3ee" },
			{ name: "Scouts", count: rc.get("scout") ?? 0, color: "#94a3b8" },
			{ name: "Hunters", count: rc.get("hunter") ?? 0, color: "#ef4444" },
			{ name: "Mission Runners", count: rc.get("mission_runner") ?? 0, color: "#f97316" },
			{ name: "Upgrading", count: rc.get("ship_upgrade") ?? 0, color: "#a855f7" },
			{ name: "Returning", count: rc.get("return_home") ?? 0, color: "#6b7280" },
		].filter(r => r.count > 0);
	});

	function fmtCount(n: number, type: string): string {
		if (type === "output") return n.toLocaleString() + " cr";
		if (type === "storage") return n.toLocaleString();
		return n + (n === 1 ? " bot" : " bots");
	}
</script>

<div class="card p-4">
	<h3 class="text-xs font-semibold text-chrome-silver uppercase tracking-wider mb-4">Supply Chain Flow</h3>

	<!-- Main pipeline -->
	<div class="flex items-stretch justify-between gap-1 overflow-x-auto py-2">
		{#each stages as stage, i}
			<div class="flex flex-col items-center min-w-[90px] flex-1">
				<span class="text-[10px] text-hull-grey uppercase tracking-wider mb-2">{stage.label}</span>
				<div class="flex flex-col gap-1 w-full">
					{#each stage.items as item}
						<div class="flex items-center gap-1.5 px-2 py-1 rounded bg-deep-void/60 border border-hull-grey/10">
							<span class="w-2 h-2 rounded-full shrink-0" style="background:{item.color}"></span>
							<span class="text-xs text-star-white truncate">{item.name}</span>
							<span class="ml-auto text-[10px] mono text-chrome-silver">{fmtCount(item.count, stage.type)}</span>
						</div>
					{:else}
						<div class="text-[10px] text-hull-grey/50 text-center py-2">none</div>
					{/each}
				</div>
			</div>

			{#if i < stages.length - 1}
				<div class="flex items-center min-w-[16px] max-w-[30px] pt-6">
					<div class="flex-1 h-px bg-hull-grey/40 relative">
						<div class="absolute right-0 top-1/2 -translate-y-1/2 w-0 h-0
							border-t-[3px] border-t-transparent
							border-b-[3px] border-b-transparent
							border-l-[5px] border-l-hull-grey/40"></div>
					</div>
				</div>
			{/if}
		{/each}
	</div>

	<!-- Support routines bar -->
	{#if supportRoutines.length > 0}
		<div class="flex items-center gap-3 mt-3 pt-3 border-t border-hull-grey/15 flex-wrap">
			<span class="text-[10px] text-hull-grey uppercase tracking-wider">Support:</span>
			{#each supportRoutines as r}
				<div class="flex items-center gap-1">
					<span class="w-1.5 h-1.5 rounded-full" style="background:{r.color}"></span>
					<span class="text-[10px] text-chrome-silver">{r.name}</span>
					<span class="text-[10px] mono text-hull-grey">{r.count}</span>
				</div>
			{/each}
		</div>
	{/if}

	{#if $bots.filter(b => b.status === "running").length === 0}
		<p class="text-xs text-hull-grey text-center mt-2">No active bots.</p>
	{/if}
</div>
