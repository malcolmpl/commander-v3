<script lang="ts">
	import { fleetAdvisor, send } from "$stores/websocket";

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

	function requestAdvisor() {
		send({ type: "request_fleet_advisor" } as any);
	}

	const advisor = $derived($fleetAdvisor);
	const timestamp = $derived(advisor?.timestamp ? new Date(advisor.timestamp).toLocaleTimeString() : null);
	const scanCoverage = $derived(advisor?.health?.scanCoverage ?? 0);
	const tradeCapacity = $derived(advisor?.health?.tradeCapacity ?? 0);
	const safetyScore = $derived(advisor?.health?.safetyScore ?? 0);
	const roleRecs = $derived((advisor?.recommendations ?? []).slice(0, 3));
	const bottlenecks = $derived((advisor?.bottlenecks ?? []).slice(0, 2));
</script>

<div class="card p-4 space-y-3">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<h3 class="text-xs text-chrome-silver uppercase tracking-wider">Fleet Advisor</h3>
		{#if timestamp}
			<span class="text-[10px] text-hull-grey mono">{timestamp}</span>
		{:else}
			<button
				class="text-[10px] text-plasma-cyan hover:text-star-white transition-colors"
				onclick={requestAdvisor}
			>
				Refresh
			</button>
		{/if}
	</div>

	{#if !advisor}
		<p class="text-xs text-hull-grey text-center py-3">No advisor data yet</p>
	{:else}
		<!-- Bot count -->
		<div class="flex items-center justify-between text-xs">
			<span class="text-chrome-silver">Bot Count</span>
			<span class="mono text-star-white">
				{advisor.currentBotCount ?? "?"} → <span class="text-plasma-cyan">{advisor.suggestedBotCount ?? "?"}</span>
			</span>
		</div>

		<!-- Estimated profit increase -->
		{#if advisor.estimatedProfitIncrease != null}
			<div class="flex items-center justify-between text-xs">
				<span class="text-chrome-silver">Est. Profit Increase</span>
				<span class="mono {advisor.estimatedProfitIncrease >= 0 ? 'text-bio-green' : 'text-claw-red'}">
					{advisor.estimatedProfitIncrease >= 0 ? "+" : ""}{advisor.estimatedProfitIncrease.toFixed(1)}%
				</span>
			</div>
		{/if}

		<!-- Role recommendations -->
		{#if roleRecs.length > 0}
			<div>
				<p class="text-[10px] text-hull-grey uppercase tracking-wider mb-1.5">Role Recommendations</p>
				<div class="space-y-1">
					{#each roleRecs as rec}
						<div class="flex items-center justify-between text-xs">
							<span class="text-star-white truncate">{rec.role?.replace(/_/g, " ") ?? rec.roleName}</span>
							<div class="flex items-center gap-2 shrink-0 ml-2">
								{#if rec.delta != null}
									<span class="mono {rec.delta >= 0 ? 'text-bio-green' : 'text-claw-red'}">
										{rec.delta >= 0 ? "+" : ""}{rec.delta}
									</span>
								{/if}
								{#if rec.estimatedProfitIncrease != null}
									<span class="text-[10px] text-warning-yellow mono">+{rec.estimatedProfitIncrease.toFixed(0)}%</span>
								{/if}
							</div>
						</div>
					{/each}
				</div>
			</div>
		{/if}

		<!-- Bottlenecks -->
		{#if bottlenecks.length > 0}
			<div>
				<p class="text-[10px] text-hull-grey uppercase tracking-wider mb-1.5">Bottlenecks</p>
				<div class="space-y-1">
					{#each bottlenecks as bottleneck}
						<div class="text-xs text-claw-red flex items-start gap-1.5">
							<span class="shrink-0 mt-0.5">&#9679;</span>
							<span class="truncate">{bottleneck}</span>
						</div>
					{/each}
				</div>
			</div>
		{/if}

		<!-- Health bars -->
		<div class="space-y-1.5">
			<p class="text-[10px] text-hull-grey uppercase tracking-wider">Fleet Health</p>

			<div class="space-y-1.5">
				<!-- Scan coverage -->
				<div>
					<div class="flex justify-between text-[10px] mb-0.5">
						<span class="text-chrome-silver">Scan Coverage</span>
						<span class="{healthTextColor(scanCoverage)} mono">{(scanCoverage * 100).toFixed(0)}%</span>
					</div>
					<div class="h-1.5 rounded-full bg-nebula-blue/50">
						<div
							class="h-full rounded-full {healthColor(scanCoverage)} transition-all"
							style="width: {Math.min(100, scanCoverage * 100).toFixed(0)}%"
						></div>
					</div>
				</div>

				<!-- Trade capacity -->
				<div>
					<div class="flex justify-between text-[10px] mb-0.5">
						<span class="text-chrome-silver">Trade Capacity</span>
						<span class="{healthTextColor(tradeCapacity)} mono">{(tradeCapacity * 100).toFixed(0)}%</span>
					</div>
					<div class="h-1.5 rounded-full bg-nebula-blue/50">
						<div
							class="h-full rounded-full {healthColor(tradeCapacity)} transition-all"
							style="width: {Math.min(100, tradeCapacity * 100).toFixed(0)}%"
						></div>
					</div>
				</div>

				<!-- Safety score -->
				<div>
					<div class="flex justify-between text-[10px] mb-0.5">
						<span class="text-chrome-silver">Safety Score</span>
						<span class="{healthTextColor(safetyScore)} mono">{(safetyScore * 100).toFixed(0)}%</span>
					</div>
					<div class="h-1.5 rounded-full bg-nebula-blue/50">
						<div
							class="h-full rounded-full {healthColor(safetyScore)} transition-all"
							style="width: {Math.min(100, safetyScore * 100).toFixed(0)}%"
						></div>
					</div>
				</div>
			</div>
		</div>

		<!-- Link to full page -->
		<a
			href="/advisor"
			class="block text-center text-xs text-plasma-cyan hover:text-star-white transition-colors border border-plasma-cyan/20 hover:border-plasma-cyan/50 rounded py-1"
		>
			Full Advisor Report →
		</a>
	{/if}
</div>
