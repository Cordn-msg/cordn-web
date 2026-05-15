<script lang="ts">
	import { goto } from '$app/navigation';

	$effect(() => {
		goto('/chat/coordinators', { replaceState: true });
	});
</script>

<svelte:head>
	<title>Redirecting coordinators… | Cordn</title>
	<meta name="description" content="Redirect to the coordinator hub." />
</svelte:head>

<div class="flex h-full min-h-0 flex-col bg-background text-foreground">
	<div class="flex flex-1 items-center justify-center px-4 py-6 text-center md:px-6 md:py-8">
		<div class="space-y-3">
			<p class="text-sm text-muted-foreground">Redirecting to the coordinator hub…</p>
			<a
				href="/chat/coordinators"
				class="text-sm font-medium text-primary underline-offset-4 hover:underline"
			>
				Open coordinator hub
			</a>
		</div>
	</div>
</div>
