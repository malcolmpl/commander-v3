<script lang="ts">
	import { commanderLog, commanderMemory, stuckBots, brainHealth, bots, send, socialChat, socialForum, socialDMs } from "$stores/websocket";
	import BrainPanel from "$lib/components/BrainPanel.svelte";

	let activeTab = $state<"chat" | "dms" | "forum" | "thoughts" | "memory" | "stuck">("chat");

	// DM filter
	let dmFilter = $state<"all" | "incoming" | "outgoing">("all");
	let dmBotFilter = $state("all");
	const filteredDMs = $derived.by(() => {
		let msgs = $socialDMs;
		if (dmFilter === "incoming") msgs = msgs.filter(m => m.direction === "incoming");
		else if (dmFilter === "outgoing") msgs = msgs.filter(m => m.direction === "outgoing");
		if (dmBotFilter !== "all") msgs = msgs.filter(m => m.botUsername === dmBotFilter);
		return msgs;
	});
	const dmBotNames = $derived([...new Set($socialDMs.map(m => m.botUsername))].sort());

	// Full thought history across all evaluations
	const allThoughts = $derived.by(() => {
		const entries: Array<{
			id: string;
			timestamp: string;
			brainName: string;
			confidence: number;
			latencyMs: number;
			tokenUsage: { input: number; output: number } | null;
			thoughts: string[];
			assignmentCount: number;
			reasoning: string;
		}> = [];

		for (let i = 0; i < $commanderLog.length; i++) {
			const d = $commanderLog[i];
			entries.push({
				id: `ev-${i}`,
				timestamp: d.timestamp,
				brainName: d.brainName ?? "ScoringBrain",
				confidence: d.confidence ?? 1,
				latencyMs: d.latencyMs ?? 0,
				tokenUsage: d.tokenUsage ?? null,
				thoughts: d.thoughts.length > 0 ? d.thoughts : [d.reasoning],
				assignmentCount: d.assignments.length,
				reasoning: d.reasoning,
			});
		}

		return entries;
	});

	// Chat filter
	let chatFilter = $state<"all" | "own" | "system" | "faction">("all");
	const filteredChat = $derived.by(() => {
		let msgs = $socialChat;
		if (chatFilter === "own") msgs = msgs.filter(m => m.isOwnBot);
		else if (chatFilter === "system") msgs = msgs.filter(m => m.channel === "system");
		else if (chatFilter === "faction") msgs = msgs.filter(m => m.channel === "faction");
		return msgs;
	});

	function formatTime(ts: string): string {
		if (!ts) return "--";
		return ts.includes("T") ? ts.slice(11, 19) : ts.slice(0, 8);
	}

	function formatTimeAgo(ts: string): string {
		const diffSec = Math.round((Date.now() - new Date(ts).getTime()) / 1000);
		if (isNaN(diffSec) || diffSec < 0) return "";
		if (diffSec < 60) return `${diffSec}s ago`;
		if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
		return `${Math.round(diffSec / 3600)}h ago`;
	}

	function confidenceColor(c: number): string {
		if (c >= 0.8) return "text-bio-green";
		if (c >= 0.5) return "text-warning-yellow";
		return "text-claw-red";
	}

	function formatLatency(ms: number): string {
		if (ms < 1000) return `${ms}ms`;
		return `${(ms / 1000).toFixed(1)}s`;
	}

	function channelColor(ch: string): string {
		if (ch === "faction") return "text-void-purple";
		if (ch === "system") return "text-laser-blue";
		if (ch === "local") return "text-bio-green";
		return "text-chrome-silver";
	}

	function channelBg(ch: string): string {
		if (ch === "faction") return "bg-void-purple/10";
		if (ch === "system") return "bg-laser-blue/10";
		if (ch === "local") return "bg-bio-green/10";
		return "bg-hull-grey/10";
	}

	function importanceColor(i: number): string {
		if (i >= 8) return "text-claw-red";
		if (i >= 5) return "text-warning-yellow";
		return "text-hull-grey";
	}

	function importanceBg(i: number): string {
		if (i >= 8) return "bg-claw-red/10 border-claw-red/30";
		if (i >= 5) return "bg-warning-yellow/10 border-warning-yellow/30";
		return "bg-nebula-blue/30 border-hull-grey/20";
	}

	function forceEval() {
		send({ type: "force_evaluation" });
	}
</script>

<svelte:head>
	<title>Social - SpaceMolt Commander</title>
</svelte:head>

<div class="space-y-4">
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold text-star-white">Social</h1>
		<div class="flex items-center gap-3">
			{#if $stuckBots.length > 0}
				<span class="px-2 py-1 text-xs font-medium rounded bg-claw-red/20 text-claw-red border border-claw-red/30">
					{$stuckBots.length} stuck
				</span>
			{/if}
			<button
				class="px-3 py-1.5 text-xs font-medium rounded-md bg-plasma-cyan/20 text-plasma-cyan border border-plasma-cyan/30 hover:bg-plasma-cyan/30 transition-colors"
				onclick={forceEval}
			>
				Force Evaluation
			</button>
		</div>
	</div>

	<div class="grid grid-cols-1 lg:grid-cols-[1fr_240px] gap-4">
		<div class="space-y-4">
			<!-- Sub-tabs -->
			<div class="flex items-center gap-1">
				{#each [
					{ value: "chat", label: "Chat", count: $socialChat.length },
					{ value: "dms", label: "DMs", count: $socialDMs.length },
					{ value: "forum", label: "Forum", count: $socialForum.length },
					{ value: "thoughts", label: "LLM Thoughts", count: allThoughts.length },
					{ value: "memory", label: "Knowledge Base", count: $commanderMemory.length },
					{ value: "stuck", label: "Stuck Bots", count: $stuckBots.length },
				] as tab}
					<button
						class="px-3 py-1.5 text-xs font-medium rounded-md transition-colors {activeTab === tab.value
							? 'bg-nebula-blue text-star-white'
							: 'text-chrome-silver hover:text-star-white hover:bg-nebula-blue/40'}"
						onclick={() => activeTab = tab.value as typeof activeTab}
					>
						{tab.label}
						{#if tab.count > 0}
							<span class="ml-1 text-hull-grey">({tab.count})</span>
						{/if}
					</button>
				{/each}
			</div>

			{#if activeTab === "chat"}
				<!-- In-game chat feed -->
				<div class="card overflow-hidden">
					<!-- Chat filter bar -->
					<div class="flex items-center gap-2 px-4 py-2 border-b border-hull-grey/20">
						{#each [
							{ value: "all", label: "All" },
							{ value: "own", label: "My Bots" },
							{ value: "system", label: "System" },
							{ value: "faction", label: "Faction" },
						] as f}
							<button
								class="px-2 py-1 text-[10px] rounded transition-colors {chatFilter === f.value
									? 'bg-nebula-blue text-star-white'
									: 'text-hull-grey hover:text-chrome-silver'}"
								onclick={() => chatFilter = f.value as typeof chatFilter}
							>
								{f.label}
							</button>
						{/each}
					</div>

					<div class="max-h-[calc(100vh-320px)] overflow-y-auto p-4 space-y-1.5">
						{#if filteredChat.length === 0}
							<div class="py-16 text-center">
								<p class="text-hull-grey text-sm">No chat messages yet.</p>
								<p class="text-hull-grey/60 text-xs mt-1">Chat history from system and faction channels will appear here when bots are online.</p>
							</div>
						{:else}
							{#each filteredChat as msg (msg.id)}
								<div class="flex items-start gap-2 py-1.5 {msg.isOwnBot ? 'bg-plasma-cyan/5 rounded-lg px-2 -mx-2' : ''}">
									<!-- Avatar -->
									<div class="shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold mt-0.5
										{msg.isOwnBot ? 'bg-plasma-cyan/20 border border-plasma-cyan/40 text-plasma-cyan' : 'bg-nebula-blue/40 border border-hull-grey/30 text-chrome-silver'}">
										{msg.username.slice(0, 2).toUpperCase()}
									</div>
									<div class="flex-1 min-w-0">
										<div class="flex items-center gap-2 mb-0.5">
											<span class="text-xs font-semibold {msg.isOwnBot ? 'text-plasma-cyan' : 'text-star-white'}">{msg.username}</span>
											<span class="px-1 py-0.5 text-[9px] rounded {channelBg(msg.channel)} {channelColor(msg.channel)}">{msg.channel}</span>
											<span class="text-[10px] text-hull-grey mono">{formatTime(msg.timestamp)}</span>
										</div>
										<p class="text-xs text-chrome-silver leading-relaxed">{msg.content}</p>
									</div>
								</div>
							{/each}
						{/if}
					</div>
				</div>


			{:else if activeTab === "dms"}
				<!-- Direct Messages -->
				<div class="card overflow-hidden">
					<!-- DM filter bar -->
					<div class="flex items-center gap-2 px-4 py-2 border-b border-hull-grey/20">
						{#each [
							{ value: "all", label: "All" },
							{ value: "incoming", label: "Incoming" },
							{ value: "outgoing", label: "Outgoing" },
						] as f}
							<button
								class="px-2 py-1 text-[10px] rounded transition-colors {dmFilter === f.value
									? 'bg-nebula-blue text-star-white'
									: 'text-hull-grey hover:text-chrome-silver'}"
								onclick={() => dmFilter = f.value as typeof dmFilter}
							>
								{f.label}
							</button>
						{/each}
						{#if dmBotNames.length > 1}
							<span class="text-hull-grey text-[10px] ml-2">Bot:</span>
							<select
								bind:value={dmBotFilter}
								class="px-1.5 py-0.5 bg-nebula-blue/30 border border-hull-grey/30 rounded text-[10px] text-star-white"
							>
								<option value="all">All Bots</option>
								{#each dmBotNames as name}
									<option value={name}>{name}</option>
								{/each}
							</select>
						{/if}
						{#if $socialDMs.length > 0}
							{@const incoming = $socialDMs.filter(m => m.direction === "incoming").length}
							<span class="ml-auto text-[10px] text-hull-grey">{incoming} incoming, {$socialDMs.length - incoming} outgoing</span>
						{/if}
					</div>

					<div class="max-h-[calc(100vh-320px)] overflow-y-auto p-4 space-y-1.5">
						{#if filteredDMs.length === 0}
							<div class="py-16 text-center">
								<p class="text-hull-grey text-sm">No direct messages yet.</p>
								<p class="text-hull-grey/60 text-xs mt-1">Private messages sent to or from your bots will appear here.</p>
							</div>
						{:else}
							{#each filteredDMs as dm (dm.id)}
								<div class="flex items-start gap-2 py-1.5 {dm.direction === 'outgoing' ? 'bg-plasma-cyan/5 rounded-lg px-2 -mx-2' : dm.direction === 'incoming' ? 'bg-warning-yellow/5 rounded-lg px-2 -mx-2' : ''}">
									<!-- Direction indicator -->
									<div class="shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold mt-0.5
										{dm.direction === 'outgoing' ? 'bg-plasma-cyan/20 border border-plasma-cyan/40 text-plasma-cyan' : 'bg-warning-yellow/20 border border-warning-yellow/40 text-warning-yellow'}">
										{dm.direction === 'outgoing' ? '\u2191' : '\u2193'}
									</div>
									<div class="flex-1 min-w-0">
										<div class="flex items-center gap-2 mb-0.5">
											{#if dm.direction === "incoming"}
												<span class="text-xs font-semibold text-warning-yellow">{dm.fromUsername}</span>
												<span class="text-[10px] text-hull-grey">\u2192</span>
												<span class="text-xs text-plasma-cyan">{dm.botUsername}</span>
											{:else}
												<span class="text-xs font-semibold text-plasma-cyan">{dm.botUsername}</span>
												<span class="text-[10px] text-hull-grey">\u2192</span>
												<span class="text-xs text-chrome-silver">{dm.toUsername || dm.fromUsername}</span>
											{/if}
											<span class="px-1 py-0.5 text-[9px] rounded {dm.direction === 'incoming' ? 'bg-warning-yellow/10 text-warning-yellow' : 'bg-plasma-cyan/10 text-plasma-cyan'}">{dm.direction}</span>
											<span class="text-[10px] text-hull-grey mono">{formatTime(dm.timestamp)}</span>
										</div>
										<p class="text-xs text-chrome-silver leading-relaxed">{dm.content}</p>
									</div>
								</div>
							{/each}
						{/if}
					</div>
				</div>
			{:else if activeTab === "forum"}
				<!-- Forum threads -->
				<div class="card overflow-hidden">
					<div class="max-h-[calc(100vh-280px)] overflow-y-auto p-4 space-y-2">
						{#if $socialForum.length === 0}
							<div class="py-16 text-center">
								<p class="text-hull-grey text-sm">No forum threads loaded.</p>
								<p class="text-hull-grey/60 text-xs mt-1">Forum threads will appear here when bots are online.</p>
							</div>
						{:else}
							{#each $socialForum as thread (thread.id)}
								<div class="p-3 rounded-lg border {thread.isOwnBot ? 'border-plasma-cyan/30 bg-plasma-cyan/5' : 'border-hull-grey/20 bg-nebula-blue/20'} hover:bg-nebula-blue/30 transition-colors">
									<div class="flex items-start justify-between gap-3">
										<div class="flex-1 min-w-0">
											<div class="flex items-center gap-2 mb-1">
												<span class="text-sm font-medium {thread.isOwnBot ? 'text-plasma-cyan' : 'text-star-white'}">{thread.title}</span>
											</div>
											<div class="flex items-center gap-3 text-[10px] text-hull-grey">
												<span class="{thread.isOwnBot ? 'text-plasma-cyan' : 'text-chrome-silver'}">{thread.author}</span>
												<span class="px-1.5 py-0.5 rounded bg-nebula-blue/40">{thread.category}</span>
												<span>{thread.replyCount} {thread.replyCount === 1 ? 'reply' : 'replies'}</span>
												<span class="mono">{formatTime(thread.createdAt)}</span>
											</div>
										</div>
										{#if thread.isOwnBot}
											<span class="px-1.5 py-0.5 text-[9px] font-medium rounded bg-plasma-cyan/20 text-plasma-cyan border border-plasma-cyan/30 shrink-0">
												YOUR BOT
											</span>
										{/if}
									</div>
								</div>
							{/each}
						{/if}
					</div>
				</div>

			{:else if activeTab === "thoughts"}
				<!-- Full LLM thought history -->
				<div class="card overflow-hidden">
					<div class="max-h-[calc(100vh-280px)] overflow-y-auto p-4 space-y-4">
						{#if allThoughts.length === 0}
							<div class="py-16 text-center">
								<p class="text-hull-grey text-sm">No evaluations yet.</p>
								<p class="text-hull-grey/60 text-xs mt-1">The commander evaluates the fleet periodically. Thoughts will appear here.</p>
							</div>
						{:else}
							{#each allThoughts as ev (ev.id)}
								<div class="border border-hull-grey/20 rounded-lg overflow-hidden">
									<!-- Evaluation header -->
									<div class="flex items-center gap-3 px-4 py-2 bg-nebula-blue/20 border-b border-hull-grey/20">
										<div class="w-7 h-7 rounded-full bg-plasma-cyan/20 border border-plasma-cyan/40 flex items-center justify-center text-plasma-cyan text-[10px] font-bold">
											AI
										</div>
										<div class="flex-1 flex items-center gap-3 flex-wrap">
											<span class="text-xs font-semibold text-plasma-cyan">{ev.brainName}</span>
											<span class="text-[10px] text-hull-grey mono">{formatTime(ev.timestamp)}</span>
											<span class="text-[10px] {confidenceColor(ev.confidence)} mono">{(ev.confidence * 100).toFixed(0)}% conf</span>
											<span class="text-[10px] text-hull-grey mono">{formatLatency(ev.latencyMs)}</span>
											{#if ev.tokenUsage}
												<span class="text-[10px] text-hull-grey mono">{ev.tokenUsage.input + ev.tokenUsage.output} tok</span>
											{/if}
											{#if ev.assignmentCount > 0}
												<span class="px-1.5 py-0.5 text-[10px] font-medium rounded bg-bio-green/20 text-bio-green border border-bio-green/30">
													{ev.assignmentCount} assignment{ev.assignmentCount > 1 ? "s" : ""}
												</span>
											{/if}
										</div>
										<span class="text-[10px] text-hull-grey">{formatTimeAgo(ev.timestamp)}</span>
									</div>

									<!-- Thought stream -->
									<div class="px-4 py-3 space-y-1.5">
										{#each ev.thoughts as thought}
											<p class="text-xs text-chrome-silver leading-relaxed">{thought}</p>
										{/each}
									</div>
								</div>
							{/each}
						{/if}
					</div>
				</div>

			{:else if activeTab === "memory"}
				<!-- Persistent knowledge base -->
				<div class="card overflow-hidden">
					<div class="max-h-[calc(100vh-280px)] overflow-y-auto p-4 space-y-2">
						{#if $commanderMemory.length === 0}
							<div class="py-16 text-center">
								<p class="text-hull-grey text-sm">No memories recorded yet.</p>
								<p class="text-hull-grey/60 text-xs mt-1">The commander builds a knowledge base of strategic facts as it operates.</p>
							</div>
						{:else}
							{#each $commanderMemory as mem (mem.key)}
								<div class="p-3 rounded-lg border {importanceBg(mem.importance)}">
									<div class="flex items-start justify-between gap-3">
										<div class="flex-1 min-w-0">
											<div class="flex items-center gap-2 mb-1">
												<span class="text-xs font-semibold text-star-white">{mem.key.replace(/_/g, " ")}</span>
												<span class="px-1.5 py-0.5 text-[10px] font-bold rounded {importanceColor(mem.importance)} bg-deep-void">
													{mem.importance}
												</span>
											</div>
											<p class="text-xs text-chrome-silver leading-relaxed">{mem.fact}</p>
										</div>
										<span class="text-[10px] text-hull-grey shrink-0">{formatTime(mem.updatedAt)}</span>
									</div>
								</div>
							{/each}
						{/if}
					</div>
				</div>

			{:else if activeTab === "stuck"}
				<!-- Stuck bot detector -->
				<div class="card overflow-hidden">
					<div class="max-h-[calc(100vh-280px)] overflow-y-auto p-4 space-y-3">
						{#if $stuckBots.length === 0}
							<div class="py-16 text-center">
								<p class="text-bio-green text-sm">All bots operating normally.</p>
								<p class="text-hull-grey/60 text-xs mt-1">Bots are flagged as stuck when their state doesn't change for 5+ minutes.</p>
							</div>
						{:else}
							{#each $stuckBots as stuck}
								{@const bot = $bots.find(b => b.id === stuck.botId)}
								<div class="p-4 rounded-lg border border-claw-red/30 bg-claw-red/5">
									<div class="flex items-start justify-between">
										<div>
											<div class="flex items-center gap-2">
												<a href="/bots/{stuck.botId}" class="text-sm font-semibold text-star-white hover:text-plasma-cyan">
													{stuck.username}
												</a>
												{#if stuck.routine}
													<span class="px-1.5 py-0.5 text-[10px] font-medium rounded bg-claw-red/20 text-claw-red border border-claw-red/30">
														{stuck.routine}
													</span>
												{/if}
											</div>
											<p class="text-xs text-chrome-silver mt-1">
												Stuck for {Math.round(stuck.stuckSinceMs / 60000)}min since {formatTime(stuck.lastStateChange)}
											</p>
											{#if bot}
												<p class="text-xs text-hull-grey mt-1">
													{bot.systemName ?? "Unknown"} &middot; Fuel {Math.round(bot.fuelPct)}% &middot; Cargo {Math.round(bot.cargoPct)}%
												</p>
											{/if}
										</div>
										<span class="text-xs text-claw-red animate-pulse">stuck</span>
									</div>
								</div>
							{/each}
							<p class="text-xs text-hull-grey text-center mt-2">
								Cooldowns have been cleared for stuck bots. The commander will reassign them on the next evaluation.
							</p>
						{/if}
					</div>
				</div>
			{/if}
		</div>

		<!-- Right sidebar -->
		<div class="space-y-4">
			<BrainPanel />

			<!-- Social stats -->
			<div class="card p-4 space-y-2">
				<h3 class="text-xs font-semibold text-chrome-silver uppercase tracking-wider">Social Activity</h3>
				<div class="flex items-center justify-between">
					<span class="text-xs text-chrome-silver">Chat Messages</span>
					<span class="text-xs mono text-star-white">{$socialChat.length}</span>
				</div>
				{#if $socialChat.length > 0}
					{@const ownMessages = $socialChat.filter(m => m.isOwnBot).length}
					<div class="flex items-center justify-between">
						<span class="text-xs text-chrome-silver">From My Bots</span>
						<span class="text-xs mono text-plasma-cyan">{ownMessages}</span>
					</div>
				{/if}
				<div class="flex items-center justify-between">
					<span class="text-xs text-chrome-silver">Direct Messages</span>
					<span class="text-xs mono text-star-white">{$socialDMs.length}</span>
				</div>
				{#if $socialDMs.length > 0}
					{@const incomingDMs = $socialDMs.filter(m => m.direction === "incoming").length}
					<div class="flex items-center justify-between">
						<span class="text-xs text-chrome-silver">Incoming DMs</span>
						<span class="text-xs mono text-warning-yellow">{incomingDMs}</span>
					</div>
				{/if}
				<div class="flex items-center justify-between">
					<span class="text-xs text-chrome-silver">Forum Threads</span>
					<span class="text-xs mono text-star-white">{$socialForum.length}</span>
				</div>
				{#if $socialForum.length > 0}
					{@const ownThreads = $socialForum.filter(t => t.isOwnBot).length}
					{#if ownThreads > 0}
						<div class="flex items-center justify-between">
							<span class="text-xs text-chrome-silver">My Bot Threads</span>
							<span class="text-xs mono text-plasma-cyan">{ownThreads}</span>
						</div>
					{/if}
				{/if}
			</div>

			<!-- Knowledge Base stats -->
			<div class="card p-4 space-y-2">
				<h3 class="text-xs font-semibold text-chrome-silver uppercase tracking-wider">Knowledge Base</h3>
				<div class="flex items-center justify-between">
					<span class="text-xs text-chrome-silver">Memories</span>
					<span class="text-xs mono text-star-white">{$commanderMemory.length}</span>
				</div>
				{#if $commanderMemory.length > 0}
					{@const highPriority = $commanderMemory.filter(m => m.importance >= 7).length}
					<div class="flex items-center justify-between">
						<span class="text-xs text-chrome-silver">High Priority</span>
						<span class="text-xs mono text-warning-yellow">{highPriority}</span>
					</div>
				{/if}
				<div class="flex items-center justify-between">
					<span class="text-xs text-chrome-silver">Stuck Bots</span>
					<span class="text-xs mono {$stuckBots.length > 0 ? 'text-claw-red' : 'text-bio-green'}">
						{$stuckBots.length}
					</span>
				</div>
			</div>
		</div>
	</div>
</div>
