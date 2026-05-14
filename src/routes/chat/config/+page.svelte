<script lang="ts">
	import { Avatar, AvatarFallback } from '$lib/components/ui/avatar';
	import Bolt from '@lucide/svelte/icons/bolt';
</script>

<svelte:head>
	<title>Config | Cordn</title>
	<meta name="description" content="Cordn chat settings placeholder." />
</svelte:head>

<div class="flex h-full min-h-0 flex-col bg-background text-foreground">
	<header class="border-b border-border bg-background/95 px-4 py-3 backdrop-blur md:px-6">
		<div class="flex items-center gap-3">
			<div
				class="flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-card"
			>
				<Bolt class="size-4" />
			</div>
			<div>
				<h1 class="text-lg font-semibold tracking-tight">Config</h1>
				<p class="text-sm text-muted-foreground">Local client preferences placeholder</p>
			</div>
		</div>
	</header>

	<div class="flex-1 overflow-y-auto px-4 py-6 md:px-6 md:py-8">
		<div class="max-w-2xl space-y-4 rounded-2xl border border-border bg-card p-6 shadow-sm">
			<div class="flex items-center gap-4">
				<Avatar class="h-12 w-12 border border-border bg-background">
					<AvatarFallback class="bg-background">YU</AvatarFallback>
				</Avatar>

				<div>
					<p class="font-medium">User placeholder</p>
					<p class="text-sm text-muted-foreground">Identity and preferences will live here.</p>
				</div>
			</div>

			<div class="grid gap-3 text-sm text-muted-foreground">
				<p>• Theme, account, and coordinator preferences can be added in this screen.</p>
				<p>• The route already exists at <code>/chat/config</code> for future work.</p>
			</div>
		</div>
	</div>
</div>
