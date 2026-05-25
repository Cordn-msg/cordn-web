<script lang="ts">
	let {
		unreadCount = 0,
		unreadReferenceCount = 0
	}: {
		unreadCount?: number;
		unreadReferenceCount?: number;
	} = $props();
</script>

{#if unreadCount > 0}
	<span
		class="absolute -top-1 -right-1 min-w-5 rounded-full bg-primary px-1.5 py-0.5 text-center text-[10px] leading-none font-semibold text-primary-foreground"
	>
		{unreadCount}
	</span>
{/if}

{#if unreadReferenceCount > 0}
	<span
		class="absolute -right-1 -bottom-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] leading-none font-semibold text-white"
		aria-label={`${unreadReferenceCount} unread reference${unreadReferenceCount === 1 ? '' : 's'}`}
	>
		@
	</span>
{/if}
