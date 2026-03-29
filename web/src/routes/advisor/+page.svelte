<script lang="ts">
	import { fleetAdvisor, dangerMapData, send } from "$stores/websocket";

	function requestAdvisor() {
		send({ type: "request_fleet_advisor" } as any);
	}

	function healthColor(score: number): string {
		if (score >= 0.75) return "bg-bio-green";
		if (score >= 0.4) return "bg-warning-yellow";
		return "bg-claw-red";
	}

	function healthTextColor(score: number): string {
		if (score >= 0.75) return "text-bio-green";
		if (score >= 0.4) return "text-warning-yellow";
		return "text-claw-red";
	}

	function dangerColor(score: number): string {
		if (score >= 0.75) return "bg-claw-red";
		if (score >= 0.4) return "bg-warning-yellow";
		return "bg-bio-green";
	}

	function dangerTextColor(score: number): string {
		if (score >= 0.75) return "text-claw-red";
		if (score >= 0.4) return "text-warning-yellow";
		return "text-bio-green";
	}

	const advisor = $derived($fleetAdvisor);
	const dangerSystems = $derived([...$dangerMapData].sort((a, b) => b.score - a.score));
	const timestamp = $derived(advisor?.timestamp ? new Date(advisor.timestamp).toLocaleString() : null);
	const scanCoverage = $derived(advisor?.health?.scanCoverage ?? 0);
	const tradeCapacity = $derived(advisor?.health?.tradeCapacity ?? 0);
	const safetyScore = $derived(advisor?.health?.safetyScore ?? 0);
	const recommendations = $derived(advisor?.recommendations ?? []);
	const bottlenecks = $derived(advisor?.bottlenecks ?? []);
	const marketCoverage = $derived(advisor?.health?.marketCoverage ?? null);
</script>

<svelte:head>
	<title>Fleet Advisor - SpaceMolt Commander</title>
</svelte:head>

<div class="space-y-6">
	<!-- Page header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-bold text-star-white">Fleet Advisor</h1>
			{#if timestamp}
				<p class="text-sm text-hull-grey mt-0.5">Last updated: {timestamp}</p>
			{:else}
				<p class="text-sm text-hull-grey mt-0.5">No data yet</p>
			{/if}
		</div>
		<button
			class="px-4 py-2 bg-plasma-cyan/10 hover:bg-plasma-cyan/20 border border-plasma-cyan/30 hover:border-plasma-cyan/60 text-plasma-cyan rounded-md text-sm font-medium transition-colors"
			onclick={requestAdvisor}
		>
			Refresh Analysis
		</button>
	</div>

	{#if !advisor}
		<!-- Waiting state -->
		<div class="card p-12 text-center">
			<p class="text-2xl text-hull-grey mb-3">&#9881;</p>
			<p class="text-star-white font-medium">Waiting for advisor data...</p>
			<p class="text-chrome-silver text-sm mt-2">Click "Refresh Analysis" to request an advisor report from the Commander.</p>
			<button
				class="mt-4 px-6 py-2 bg-plasma-cyan/10 hover:bg-plasma-cyan/20 border border-plasma-cyan/30 text-plasma-cyan rounded-md text-sm font-medium transition-colors"
				onclick={requestAdvisor}
			>
				Request Now
			</button>
		</div>
	{:else}
		<!-- Summary cards -->
		<div class="grid grid-cols-2 md:grid-cols-4 gap-3">
			<div class="card p-4">
				<p class="text-xs text-chrome-silver uppercase tracking-wider">Current Fleet</p>
				<p class="text-3xl font-bold mono text-star-white mt-1">{advisor.currentBotCount ?? "?"}</p>
				<p class="text-xs text-hull-grey mt-0.5">bots active</p>
			</div>
			<div class="card p-4">
				<p class="text-xs text-chrome-silver uppercase tracking-wider">Suggested Fleet</p>
				<p class="text-3xl font-bold mono text-plasma-cyan mt-1">{advisor.suggestedBotCount ?? "?"}</p>
				<p class="text-xs text-hull-grey mt-0.5">bots recommended</p>
			</div>
			<div class="card p-4">
				<p class="text-xs text-chrome-silver uppercase tracking-wider">Est. Profit Increase</p>
				{#if advisor.estimatedProfitIncrease != null}
					<p class="text-3xl font-bold mono {advisor.estimatedProfitIncrease >= 0 ? 'text-bio-green' : 'text-claw-red'} mt-1">
						{advisor.estimatedProfitIncrease >= 0 ? "+" : ""}{advisor.estimatedProfitIncrease.toFixed(1)}%
					</p>
				{:else}
					<p class="text-3xl font-bold mono text-hull-grey mt-1">---</p>
				{/if}
				<p class="text-xs text-hull-grey mt-0.5">if recommendations applied</p>
			</div>
			<div class="card p-4">
				<p class="text-xs text-chrome-silver uppercase tracking-wider">Market Coverage</p>
				{#if marketCoverage != null}
					<p class="text-3xl font-bold mono {healthTextColor(marketCoverage)} mt-1">{(marketCoverage * 100).toFixed(0)}%</p>
				{:else}
					<p class="text-3xl font-bold mono {healthTextColor(tradeCapacity)} mt-1">{(tradeCapacity * 100).toFixed(0)}%</p>
				{/if}
				<p class="text-xs text-hull-grey mt-0.5">trade routes covered</p>
			</div>
		</div>

		<!-- Main content grid -->
		<div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
			<!-- Left: Recommendations + Bottlenecks -->
			<div class="lg:col-span-2 space-y-6">
				<!-- Recommendations table -->
				<div class="card p-4">
					<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-4">Role Recommendations</h2>
					{#if recommendations.length === 0}
						<p class="text-sm text-hull-grey text-center py-6">No role recommendations available</p>
					{:else}
						<div class="overflow-x-auto">
							<table class="w-full text-sm">
								<thead>
									<tr class="text-left text-xs text-chrome-silver uppercase tracking-wider border-b border-hull-grey/30">
										<th class="pb-2 pr-4">Role</th>
										<th class="pb-2 pr-4 text-right">Current</th>
										<th class="pb-2 pr-4 text-right">Suggested</th>
										<th class="pb-2 pr-4 text-right">Delta</th>
										<th class="pb-2 text-right">Est. Profit+</th>
									</tr>
								</thead>
								<tbody class="divide-y divide-hull-grey/20">
									{#each recommendations as rec}
										<tr class="hover:bg-nebula-blue/20 transition-colors">
											<td class="py-2 pr-4">
												<span class="text-star-white font-medium">{rec.role?.replace(/_/g, " ") ?? rec.roleName ?? "Unknown"}</span>
												{#if rec.reason}
													<p class="text-[10px] text-hull-grey mt-0.5 truncate max-w-[200px]">{rec.reason}</p>
												{/if}
											</td>
											<td class="py-2 pr-4 text-right mono text-chrome-silver">{rec.currentCount ?? "?"}</td>
											<td class="py-2 pr-4 text-right mono text-plasma-cyan">{rec.suggestedCount ?? "?"}</td>
											<td class="py-2 pr-4 text-right mono">
												{#if rec.delta != null}
													<span class="{rec.delta > 0 ? 'text-bio-green' : rec.delta < 0 ? 'text-claw-red' : 'text-chrome-silver'}">
														{rec.delta > 0 ? "+" : ""}{rec.delta}
													</span>
												{:else}
													<span class="text-hull-grey">---</span>
												{/if}
											</td>
											<td class="py-2 text-right mono">
												{#if rec.estimatedProfitIncrease != null}
													<span class="text-warning-yellow">+{rec.estimatedProfitIncrease.toFixed(1)}%</span>
												{:else}
													<span class="text-hull-grey">---</span>
												{/if}
											</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
					{/if}
				</div>

				<!-- Bottlenecks -->
				{#if bottlenecks.length > 0}
					<div class="card p-4 border border-claw-red/30">
						<h2 class="text-sm font-semibold text-claw-red uppercase tracking-wider mb-3">Bottlenecks</h2>
						<div class="space-y-2">
							{#each bottlenecks as bottleneck, i}
								<div class="flex items-start gap-3 text-sm p-2 rounded bg-claw-red/5 border border-claw-red/10">
									<span class="text-claw-red shrink-0 font-bold mono text-xs mt-0.5">{String(i + 1).padStart(2, "0")}</span>
									<span class="text-chrome-silver">{bottleneck}</span>
								</div>
							{/each}
						</div>
					</div>
				{/if}
			</div>

			<!-- Right: Fleet health -->
			<div class="space-y-4">
				<div class="card p-4">
					<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-4">Fleet Health</h2>
					<div class="space-y-4">
						<!-- Scan coverage -->
						<div>
							<div class="flex justify-between text-sm mb-1.5">
								<span class="text-chrome-silver">Scan Coverage</span>
								<span class="{healthTextColor(scanCoverage)} mono font-medium">{(scanCoverage * 100).toFixed(0)}%</span>
							</div>
							<div class="h-2 rounded-full bg-nebula-blue/50">
								<div
									class="h-full rounded-full {healthColor(scanCoverage)} transition-all"
									style="width: {Math.min(100, scanCoverage * 100).toFixed(0)}%"
								></div>
							</div>
							<p class="text-[10px] text-hull-grey mt-1">Galaxy systems with active explorers</p>
						</div>

						<!-- Trade capacity -->
						<div>
							<div class="flex justify-between text-sm mb-1.5">
								<span class="text-chrome-silver">Trade Capacity</span>
								<span class="{healthTextColor(tradeCapacity)} mono font-medium">{(tradeCapacity * 100).toFixed(0)}%</span>
							</div>
							<div class="h-2 rounded-full bg-nebula-blue/50">
								<div
									class="h-full rounded-full {healthColor(tradeCapacity)} transition-all"
									style="width: {Math.min(100, tradeCapacity * 100).toFixed(0)}%"
								></div>
							</div>
							<p class="text-[10px] text-hull-grey mt-1">Trade routes actively serviced</p>
						</div>

						<!-- Safety score -->
						<div>
							<div class="flex justify-between text-sm mb-1.5">
								<span class="text-chrome-silver">Safety Score</span>
								<span class="{healthTextColor(safetyScore)} mono font-medium">{(safetyScore * 100).toFixed(0)}%</span>
							</div>
							<div class="h-2 rounded-full bg-nebula-blue/50">
								<div
									class="h-full rounded-full {healthColor(safetyScore)} transition-all"
									style="width: {Math.min(100, safetyScore * 100).toFixed(0)}%"
								></div>
							</div>
							<p class="text-[10px] text-hull-grey mt-1">Fleet operating in safe systems</p>
						</div>
					</div>
				</div>

				<!-- Advisor notes / summary -->
				{#if advisor.summary || advisor.notes}
					<div class="card p-4">
						<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-2">Summary</h2>
						<p class="text-sm text-chrome-silver leading-relaxed">{advisor.summary ?? advisor.notes}</p>
					</div>
				{/if}
			</div>
		</div>

		<!-- Danger Map -->
		{#if dangerSystems.length > 0}
			<div class="card p-4">
				<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-4">Danger Map</h2>
				<div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
					{#each dangerSystems as sys}
						<div class="bg-white/5 border border-white/10 rounded-lg p-3 space-y-2">
							<div class="flex items-center justify-between">
								<span class="text-xs text-star-white font-medium truncate flex-1">{sys.systemId}</span>
								<span class="text-xs mono {dangerTextColor(sys.score)} shrink-0 ml-1">{(sys.score * 100).toFixed(0)}</span>
							</div>
							<!-- Danger bar -->
							<div class="h-1.5 rounded-full bg-nebula-blue/50">
								<div
									class="h-full rounded-full {dangerColor(sys.score)} transition-all"
									style="width: {Math.min(100, sys.score * 100).toFixed(0)}%"
								></div>
							</div>
							<div class="flex items-center justify-between text-[10px] text-hull-grey">
								<span>{sys.attacks} attacks</span>
								{#if sys.lastAttack}
									<span>{Math.round((Date.now() - sys.lastAttack) / 60000)}m ago</span>
								{/if}
							</div>
						</div>
					{/each}
				</div>
			</div>
		{:else}
			<div class="card p-4">
				<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-2">Danger Map</h2>
				<p class="text-sm text-hull-grey text-center py-4">No danger data available — all systems appear safe.</p>
			</div>
		{/if}
	{/if}
</div>
