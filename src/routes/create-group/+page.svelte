<script lang="ts">
	import { goto } from '$app/navigation';

	$effect(() => {
		goto('/chat/create-group', { replaceState: true });
	});
</script>

<svelte:head>
	<title>Redirecting to create group | Cordn</title>
	<meta name="description" content="Redirecting to create group." />
</svelte:head>

<div class="flex min-h-screen items-center justify-center px-4 py-8 text-center">
	<div class="space-y-3">
		<p class="text-sm text-muted-foreground">Redirecting to create group…</p>
		<a
			href="/chat/create-group"
			class="text-sm font-medium text-primary underline-offset-4 hover:underline"
		>
			Open create group
		</a>
	</div>
</div>
