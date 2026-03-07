<script lang="ts">
	import { bots, send } from "$stores/websocket";
	import { goto } from "$app/navigation";

	interface Props {
		open: boolean;
		onclose: () => void;
	}

	let { open = $bindable(), onclose }: Props = $props();
	let query = $state("");
	let selectedIndex = $state(0);
	let inputEl: HTMLInputElement | undefined = $state();

	interface PaletteItem {
		id: string;
		label: string;
		category: "page" | "bot" | "action";
		description: string;
		action: () => void;
	}

	const pages: PaletteItem[] = [
		{ id: "p-fleet", label: "Fleet Overview", category: "page", description: "Dashboard home", action: () => goto("/") },
		{ id: "p-bots", label: "Bot Management", category: "page", description: "Fleet bots list", action: () => goto("/bots") },
		{ id: "p-commander", label: "Commander Log", category: "page", description: "AI decisions and orders", action: () => goto("/commander") },
		{ id: "p-social", label: "Social", category: "page", description: "LLM thoughts, memory, stuck bots", action: () => goto("/social") },
		{ id: "p-economy", label: "Economy", category: "page", description: "Revenue, costs, supply chain", action: () => goto("/economy") },
		{ id: "p-faction", label: "Faction", category: "page", description: "Members, storage, diplomacy", action: () => goto("/faction") },
		{ id: "p-market", label: "Market", category: "page", description: "Prices and arbitrage", action: () => goto("/market") },
		{ id: "p-training", label: "Training Data", category: "page", description: "Stats and exports", action: () => goto("/training") },
		{ id: "p-settings", label: "Settings", category: "page", description: "Goals, config, cache", action: () => goto("/settings") },
	];

	const actions: PaletteItem[] = [
		{
			id: "a-eval", label: "Force Evaluation", category: "action",
			description: "Trigger immediate commander eval",
			action: () => send({ type: "force_evaluation" }),
		},
		{
			id: "a-refresh", label: "Refresh Cache", category: "action",
			description: "Reload galaxy and market data",
			action: () => send({ type: "refresh_cache" }),
		},
	];

	const allItems = $derived.by((): PaletteItem[] => {
		const botItems: PaletteItem[] = $bots.map(b => ({
			id: `b-${b.id}`,
			label: b.username,
			category: "bot" as const,
			description: `${b.status} ${b.routine ? `· ${b.routine}` : ""}`,
			action: () => goto(`/bots/${b.id}`),
		}));

		const all = [...pages, ...botItems, ...actions];

		if (!query.trim()) return all;
		const q = query.toLowerCase();
		return all.filter(item =>
			item.label.toLowerCase().includes(q) ||
			item.description.toLowerCase().includes(q) ||
			item.category.includes(q)
		);
	});

	$effect(() => {
		if (open) {
			query = "";
			selectedIndex = 0;
			// Focus input after render
			setTimeout(() => inputEl?.focus(), 50);
		}
	});

	// Reset selection when results change
	$effect(() => {
		if (allItems.length > 0 && selectedIndex >= allItems.length) {
			selectedIndex = 0;
		}
	});

	function handleKeydown(e: KeyboardEvent) {
		switch (e.key) {
			case "ArrowDown":
				e.preventDefault();
				selectedIndex = (selectedIndex + 1) % allItems.length;
				break;
			case "ArrowUp":
				e.preventDefault();
				selectedIndex = (selectedIndex - 1 + allItems.length) % allItems.length;
				break;
			case "Enter":
				e.preventDefault();
				if (allItems[selectedIndex]) {
					allItems[selectedIndex].action();
					onclose();
				}
				break;
			case "Escape":
				e.preventDefault();
				onclose();
				break;
		}
	}

	function selectItem(item: PaletteItem) {
		item.action();
		onclose();
	}

	const categoryIcon: Record<string, string> = {
		page: "P",
		bot: "B",
		action: "A",
	};

	const categoryColor: Record<string, string> = {
		page: "text-plasma-cyan",
		bot: "text-bio-green",
		action: "text-warning-yellow",
	};
</script>

{#if open}
	<!-- Backdrop -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-start justify-center pt-[15vh]"
		onmousedown={(e) => { if (e.target === e.currentTarget) onclose(); }}
		onkeydown={handleKeydown}
	>
		<div class="w-full max-w-lg bg-deep-void border border-hull-grey rounded-xl shadow-2xl overflow-hidden">
			<!-- Search input -->
			<div class="flex items-center gap-2 px-4 py-3 border-b border-hull-grey/50">
				<span class="text-hull-grey text-sm">&#9906;</span>
				<input
					bind:this={inputEl}
					bind:value={query}
					type="text"
					placeholder="Search pages, bots, actions..."
					class="flex-1 bg-transparent text-star-white text-sm placeholder:text-hull-grey outline-none"
				/>
				<kbd class="px-1.5 py-0.5 text-[10px] text-hull-grey bg-nebula-blue rounded border border-hull-grey/50">ESC</kbd>
			</div>

			<!-- Results -->
			<div class="max-h-[50vh] overflow-y-auto py-1">
				{#if allItems.length === 0}
					<div class="px-4 py-8 text-center">
						<p class="text-sm text-hull-grey">No results for "{query}"</p>
					</div>
				{:else}
					{#each allItems as item, i (item.id)}
						<button
							class="w-full flex items-center gap-3 px-4 py-2 text-left transition-colors
								{i === selectedIndex ? 'bg-nebula-blue/60' : 'hover:bg-nebula-blue/30'}"
							onmouseenter={() => selectedIndex = i}
							onclick={() => selectItem(item)}
						>
							<span class="w-6 h-6 rounded-md flex items-center justify-center text-[10px] font-bold bg-nebula-blue border border-hull-grey/30 {categoryColor[item.category]}">
								{categoryIcon[item.category]}
							</span>
							<div class="flex-1 min-w-0">
								<span class="text-sm text-star-white">{item.label}</span>
								<span class="text-xs text-hull-grey ml-2">{item.description}</span>
							</div>
							{#if i === selectedIndex}
								<kbd class="px-1 py-0.5 text-[10px] text-hull-grey bg-nebula-blue/60 rounded border border-hull-grey/40">Enter</kbd>
							{/if}
						</button>
					{/each}
				{/if}
			</div>

			<!-- Footer -->
			<div class="px-4 py-2 border-t border-hull-grey/30 flex items-center gap-3 text-[10px] text-hull-grey">
				<span>&#8593;&#8595; navigate</span>
				<span>&#9166; select</span>
				<span>esc close</span>
			</div>
		</div>
	</div>
{/if}
