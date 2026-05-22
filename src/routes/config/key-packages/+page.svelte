<script lang="ts">
	import { goto } from '$app/navigation';

	$effect(() => {
		goto('/chat/config/key-packages', { replaceState: true });
	});
</script>

<svelte:head>
	<title>Redirecting to key packages | Cordn</title>
	<meta name="description" content="Redirecting to chat key packages." />
</svelte:head>

<div class="flex min-h-screen items-center justify-center px-4 py-8 text-center">
	<div class="space-y-3">
		<p class="text-sm text-muted-foreground">Redirecting to key packages…</p>
		<a
			href="/chat/config/key-packages"
			class="text-sm font-medium text-primary underline-offset-4 hover:underline"
		>
			Open key packages
		</a>
	</div>
</div>
