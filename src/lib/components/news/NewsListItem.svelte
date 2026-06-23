<script lang="ts">
	import Megaphone from '@lucide/svelte/icons/megaphone';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import ChatGroupUnreadChips from '$lib/components/chat/ChatGroupUnreadChips.svelte';

	let {
		href,
		title = 'News & updates',
		preview = 'Release notes and product news',
		unreadCount = 0,
		collapsed = false,
		variant = 'card',
		active = false,
		onclick
	}: {
		href: string;
		title?: string;
		preview?: string;
		unreadCount?: number;
		collapsed?: boolean;
		variant?: 'card' | 'sidebar';
		active?: boolean;
		onclick?: (event: MouseEvent) => void;
	} = $props();

	const isSidebar = $derived(variant === 'sidebar');
	const avatarClass = $derived(isSidebar ? 'h-10 w-10' : 'h-12 w-12');
	const linkClass = $derived.by(() => {
		if (isSidebar) {
			return `flex items-center gap-3 rounded-xl border px-3 py-3 text-sm transition-colors ${
				collapsed ? 'justify-center px-2' : 'ml-1'
			} ${
				active
					? 'border-primary bg-primary/10 text-foreground'
					: 'border-transparent text-muted-foreground hover:border-border hover:bg-background hover:text-foreground'
			}`;
		}
		return 'group flex items-center gap-3 rounded-2xl border border-border p-4 transition-colors hover:border-foreground/20 hover:bg-muted/30';
	});
</script>

<!-- The caller passes route hrefs resolved with $app/paths when route params are needed. -->
<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
<a {href} {onclick} class={linkClass}>
	<div class="relative shrink-0">
		<div
			class={`flex ${avatarClass} items-center justify-center rounded-xl border border-border bg-background text-foreground`}
		>
			<Megaphone class={isSidebar ? 'size-4' : 'size-5'} />
		</div>
		<ChatGroupUnreadChips {unreadCount} />
	</div>

	{#if !collapsed}
		<div class="min-w-0 flex-1 overflow-hidden">
			<p class="truncate font-medium text-foreground">{title}</p>
			<p
				class={isSidebar
					? 'truncate text-xs leading-5 text-muted-foreground'
					: 'truncate text-sm text-muted-foreground'}
			>
				{preview}
			</p>
		</div>

		{#if !isSidebar}
			<ExternalLink
				class="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
			/>
		{/if}
	{/if}
</a>
