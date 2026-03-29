<script lang="ts">
	import { bots, fleetStats, commanderLog, activityLog, connectionState, economy } from "$stores/websocket";
	import CreditsChart from "$lib/components/CreditsChart.svelte";
	import FleetAdvisorCard from "$lib/components/FleetAdvisorCard.svelte";

	const ROLE_LABELS: Record<string, string> = {
		ore_miner: "Miner-Ore",
		crystal_miner: "Miner-Crystal",
		gas_harvester: "Miner-Gas",
		ice_harvester: "Miner-Ice",
		explorer: "Explorer",
		trader: "Trader",
		crafter: "Crafter",
		quartermaster: "Quartermaster",
		hunter: "Hunter",
		mission_runner: "Mission Runner",
		ship_dealer: "Ship Dealer",
		shipwright: "Crafter-Shipwright",
	};
	function roleLabel(role: string | null): string {
		if (!role) return "--";
		return ROLE_LABELS[role] ?? role.replace(/_/g, " ");
	}

	// Derive top trades from activity log (merged from Activity page)
	const topTrades = $derived.by(() => {
		return $activityLog
			.filter(e => e.message.includes("sold") || e.message.includes("Sold"))
			.slice(0, 5);
	});

	const craftingFeed = $derived.by(() => {
		return $activityLog
			.filter(e => e.message.includes("craft") || e.message.includes("Craft"))
			.slice(0, 5);
	});
</script>

<svelte:head>
	<title>Fleet - SpaceMolt Commander</title>
</svelte:head>

<div class="space-y-4">
	<!-- Page header -->
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold text-star-white">Fleet Overview</h1>
		<div class="flex items-center gap-2 text-sm">
			<span
				class="status-dot"
				class:active={$connectionState === "connected"}
				class:error={$connectionState === "disconnected"}
				class:idle={$connectionState === "connecting"}
			></span>
			<span class="text-chrome-silver capitalize">{$connectionState}</span>
		</div>
	</div>

	<!-- Stats row -->
	<div class="grid grid-cols-2 md:grid-cols-4 gap-3">
		<div class="card p-4">
			<p class="text-xs text-chrome-silver uppercase tracking-wider">Total Credits</p>
			<p class="text-2xl font-bold mono text-star-white mt-1">
				{$fleetStats?.totalCredits?.toLocaleString() ?? "---"}
			</p>
		</div>
		<div class="card p-4">
			<p class="text-xs text-chrome-silver uppercase tracking-wider">Session Earned</p>
			<p class="text-2xl font-bold mono {$fleetStats && $fleetStats.creditsPerHour >= 0 ? 'text-bio-green' : 'text-claw-red'} mt-1">
				{#if $fleetStats}
					{$fleetStats.creditsPerHour >= 0 ? '+' : ''}{$fleetStats.creditsPerHour.toLocaleString()}
				{:else}
					---
				{/if}
				<span class="text-sm text-chrome-silver">earned</span>
			</p>
		</div>
		<div class="card p-4">
			<p class="text-xs text-chrome-silver uppercase tracking-wider">Active Bots</p>
			<p class="text-2xl font-bold mono text-star-white mt-1">
				{$fleetStats ? `${$fleetStats.activeBots}/${$fleetStats.totalBots}` : "---"}
			</p>
		</div>
		<div class="card p-4">
			<p class="text-xs text-chrome-silver uppercase tracking-wider">Net Profit 24h</p>
			<p class="text-2xl font-bold mono {$economy && $economy.netProfit24h >= 0 ? 'text-bio-green' : 'text-claw-red'} mt-1">
				{$economy ? `${$economy.netProfit24h >= 0 ? '+' : ''}${$economy.netProfit24h.toLocaleString()}` : "---"}
				<span class="text-sm text-chrome-silver">cr</span>
			</p>
		</div>
	</div>

	<div class="grid grid-cols-1 lg:grid-cols-4 gap-4">
		<!-- Credits chart + Commander thoughts -->
		<div class="lg:col-span-3 space-y-4">
			<div class="card p-4">
				<div class="h-64">
					<CreditsChart />
				</div>
			</div>

			<!-- Bot roster table -->
			<div class="card p-4">
				<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-3">
					Bot Roster
				</h2>
				{#if $bots.length === 0}
					<div class="py-12 text-center">
						<p class="text-hull-grey">No bots registered</p>
						<p class="text-sm text-hull-grey mt-1">
							Go to <a href="/bots" class="text-plasma-cyan hover:underline">Bots</a> to add your first bot
						</p>
					</div>
				{:else}
					<div class="overflow-x-auto">
						<table class="w-full text-sm">
							<thead>
								<tr class="text-left text-xs text-chrome-silver uppercase tracking-wider border-b border-hull-grey/30">
									<th class="pb-2 pr-4">Status</th>
									<th class="pb-2 pr-4">Bot</th>
									<th class="pb-2 pr-4">Role</th>
									<th class="pb-2 pr-4">Ship</th>
									<th class="pb-2 pr-4">Routine</th>
									<th class="pb-2 pr-4">State</th>
									<th class="pb-2 pr-4">Location</th>
									<th class="pb-2 pr-4 text-right">Credits</th>
									<th class="pb-2 pr-4 text-right">Earned</th>
									<th class="pb-2 pr-4 text-right">Fuel</th>
									<th class="pb-2 text-right">Cargo</th>
								</tr>
							</thead>
							<tbody class="divide-y divide-hull-grey/20">
								{#each $bots as bot}
									<tr class="hover:bg-nebula-blue/20 transition-colors">
										<td class="py-2 pr-4">
											<span
												class="status-dot"
												class:active={bot.status === "running"}
												class:idle={bot.status === "idle" || bot.status === "ready"}
												class:error={bot.status === "error"}
												class:offline={bot.status === "stopping"}
											></span>
										</td>
										<td class="py-2 pr-4">
											<a href="/bots/{bot.id}" class="text-star-white hover:text-plasma-cyan font-medium">
												{bot.username}
											</a>
										</td>
										<td class="py-2 pr-4">
											<span class="text-plasma-cyan text-[10px] px-1.5 py-0.5 rounded bg-plasma-cyan/10 border border-plasma-cyan/20">{roleLabel(bot.role)}</span>
										</td>
										<td class="py-2 pr-4 text-chrome-silver text-xs">
											{bot.shipName ?? bot.shipClass ?? "--"}
										</td>
										<td class="py-2 pr-4">
											{#if bot.routine}
												<span
													class="inline-block px-2 py-0.5 rounded text-xs font-medium"
													style="background: color-mix(in srgb, var(--color-routine-{bot.routine}) 20%, transparent); color: var(--color-routine-{bot.routine})"
												>
													{bot.routine}
												</span>
											{:else}
												<span class="text-hull-grey">--</span>
											{/if}
										</td>
										<td class="py-2 pr-4 text-chrome-silver text-xs max-w-[200px] truncate">
											{bot.routineState || "--"}
										</td>
										<td class="py-2 pr-4 text-chrome-silver text-xs">
											{bot.systemName ?? "Unknown"}{#if bot.poiName}<span class="text-hull-grey"> - </span><span class="text-star-white">{bot.poiName}</span>{/if}
											{#if bot.docked}
												<span class="text-laser-blue ml-1">docked</span>
											{/if}
										</td>
										<td class="py-2 pr-4 text-right mono text-star-white">
											{bot.credits.toLocaleString()}
										</td>
										<td class="py-2 pr-4 text-right mono {bot.creditsPerHour >= 0 ? 'text-bio-green' : 'text-claw-red'}">
											{bot.creditsPerHour >= 0 ? "+" : ""}{bot.creditsPerHour.toLocaleString()}
										</td>
										<td class="py-2 pr-4 text-right mono">
											<span class={bot.fuelPct < 20 ? "text-claw-red" : bot.fuelPct < 50 ? "text-warning-yellow" : "text-star-white"}>
												{Math.round(bot.fuelPct)}%
											</span>
										</td>
										<td class="py-2 text-right mono">
											<span class="text-star-white">{Math.round(bot.cargoPct)}%</span>
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			</div>
		</div>

		<!-- Right sidebar (merged from Activity page) -->
		<div class="space-y-3">
			<!-- Fleet Advisor -->
			<FleetAdvisorCard />

			<!-- Commander thoughts -->
			<div class="card p-4">
				<h3 class="text-xs text-chrome-silver uppercase tracking-wider mb-2">Commander Thoughts</h3>
				<div class="space-y-1.5 max-h-48 overflow-y-auto">
					{#if $commanderLog.length === 0}
						<p class="text-sm text-hull-grey">Commander is thinking...</p>
					{:else}
						{@const latest = $commanderLog[0]}
						{#if latest.thoughts && latest.thoughts.length > 0}
							{#each latest.thoughts as thought}
								<p class="text-xs text-chrome-silver leading-relaxed">{thought}</p>
							{/each}
						{:else}
							<p class="text-xs text-chrome-silver">{latest.reasoning}</p>
						{/if}
						<p class="text-hull-grey text-[10px] mt-2 border-t border-hull-grey/20 pt-1">
							{latest.timestamp.slice(11, 19)} &middot; {latest.assignments.length} assignment(s)
							{#if latest.brainName}
								&middot; {latest.brainName}
							{/if}
						</p>
					{/if}
				</div>
			</div>

			<!-- Top Trades -->
			<div class="card p-4">
				<h3 class="text-xs text-chrome-silver uppercase tracking-wider mb-2">Top Trades</h3>
				{#if topTrades.length === 0}
					<p class="text-xs text-hull-grey text-center py-3">No trades yet</p>
				{:else}
					<div class="space-y-1.5">
						{#each topTrades as trade}
							<div class="text-xs">
								<span class="text-hull-grey mono">{trade.timestamp.slice(11, 19)}</span>
								{#if trade.botId}
									<a href="/bots/{trade.botId}" class="text-laser-blue ml-1">{trade.botId}</a>
								{/if}
								<p class="text-chrome-silver truncate">{trade.message}</p>
							</div>
						{/each}
					</div>
				{/if}
			</div>

			<!-- Open Orders -->
			<div class="card p-4">
				<h3 class="text-xs text-chrome-silver uppercase tracking-wider mb-2">Open Orders</h3>
				{#if !$economy?.openOrders?.length}
					<p class="text-xs text-hull-grey text-center py-3">No orders</p>
				{:else}
					<div class="space-y-1.5">
						{#each $economy.openOrders.slice(0, 5) as order}
							<div class="flex items-center justify-between text-xs">
								<span class="text-star-white truncate">{order.itemName}</span>
								<span class="{order.type === 'buy' ? 'text-bio-green' : 'text-shell-orange'} mono">
									{order.type === "buy" ? "B" : "S"} {order.priceEach}
								</span>
							</div>
						{/each}
					</div>
				{/if}
			</div>

			<!-- Crafting Feed -->
			<div class="card p-4">
				<h3 class="text-xs text-chrome-silver uppercase tracking-wider mb-2">Crafting</h3>
				{#if craftingFeed.length === 0}
					<p class="text-xs text-hull-grey text-center py-3">No crafting</p>
				{:else}
					<div class="space-y-1.5">
						{#each craftingFeed as craft}
							<div class="text-xs">
								<span class="text-hull-grey mono">{craft.timestamp.slice(11, 19)}</span>
								<p class="text-chrome-silver truncate">{craft.message}</p>
							</div>
						{/each}
					</div>
				{/if}
			</div>

			<!-- Recent Activity -->
			<div class="card p-4">
				<h3 class="text-xs text-chrome-silver uppercase tracking-wider mb-2">Recent Activity</h3>
				<div class="space-y-1 max-h-48 overflow-y-auto">
					{#if $activityLog.length === 0}
						<p class="text-sm text-hull-grey">No activity yet</p>
					{:else}
						{#each $activityLog.slice(0, 15) as entry}
							<div class="flex items-start gap-2 text-xs py-0.5">
								<span class="text-hull-grey shrink-0 mono">{entry.timestamp.slice(11, 19)}</span>
								<span
									class="shrink-0 {entry.level === 'error'
										? 'text-claw-red'
										: entry.level === 'warn'
											? 'text-warning-yellow'
											: entry.level === 'cmd'
												? 'text-plasma-cyan'
												: 'text-chrome-silver'}"
								>
									[{entry.level}]
								</span>
								{#if entry.botId}
									<a href="/bots/{entry.botId}" class="text-laser-blue shrink-0">{entry.botId}</a>
								{/if}
								<span class="text-star-white truncate">{entry.message}</span>
							</div>
						{/each}
					{/if}
				</div>
			</div>
		</div>
	</div>
</div>
