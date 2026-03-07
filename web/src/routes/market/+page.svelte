<script lang="ts">
	import { goto } from "$app/navigation";
	import { onMount } from "svelte";
	onMount(() => goto("/economy", { replaceState: true }));
</script>

<p class="text-chrome-silver text-center py-8">Redirecting to Economy...</p>
