<script lang="ts">
	import { goto } from '$app/navigation';

	$effect(() => {
		goto('/chat/coordinators', { replaceState: true });
	});
</script>

<svelte:head>
	<title>Redirecting to coordinators | Cordn</title>
	<meta name="description" content="Redirecting to the chat coordinators page." />
</svelte:head>

<div class="flex min-h-screen items-center justify-center px-4 py-8 text-center">
	<div class="space-y-3">
		<p class="text-sm text-muted-foreground">Redirecting to coordinators…</p>
		<a
			href="/chat/coordinators"
			class="text-sm font-medium text-primary underline-offset-4 hover:underline"
		>
			Open coordinators
		</a>
	</div>
</div>
