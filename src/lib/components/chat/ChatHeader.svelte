<script lang="ts">
	import { Avatar, AvatarFallback } from '$lib/components/ui/avatar';

	let { title = 'Cordn', subtitle = 'Coordinator-assisted messaging' } = $props();
</script>

<header
	class="border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80"
>
	<div class="flex items-center justify-between gap-4 px-4 py-3 md:px-6">
		<div class="flex min-w-0 items-center gap-3">
			<Avatar class="h-10 w-10 border border-border bg-card">
				<AvatarFallback class="bg-card text-base">🪢</AvatarFallback>
			</Avatar>

			<div class="min-w-0">
				<h1 class="truncate text-lg font-semibold tracking-tight">{title}</h1>
				<p class="truncate text-sm text-muted-foreground">{subtitle}</p>
			</div>
		</div>
	</div>
</header>
