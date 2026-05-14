<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { Avatar, AvatarFallback } from '$lib/components/ui/avatar';
	import { Button } from '$lib/components/ui/button';
	import Bolt from '@lucide/svelte/icons/bolt';
	import ChevronLeft from '@lucide/svelte/icons/chevron-left';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';

	type NavItem = {
		id: string;
		name: string;
		icon: string;
	};

	const chats: NavItem[] = [
		{ id: 'general', name: 'General', icon: 'G' },
		{ id: 'research', name: 'Research', icon: 'R' },
		{ id: 'ops', name: 'Ops', icon: 'O' }
	];

	let collapsed = $state(false);

	function isActive(href: string) {
		return page.url.pathname === href;
	}

	function getGroupHref(groupId: string) {
		return resolve('/chat/[id]', { id: groupId });
	}

	const sidebarClass = $derived(collapsed ? 'w-20 px-2.5' : 'w-72 px-3');
</script>

<aside
	class={`flex h-full shrink-0 flex-col overflow-hidden border-r border-border bg-card/60 py-3 transition-[width,padding] duration-200 ${sidebarClass}`}
>
	<div class={`flex items-center pb-4 ${collapsed ? 'justify-center' : 'justify-between gap-2'}`}>
		<div class={`flex min-w-0 items-center gap-3 ${collapsed ? 'justify-center' : ''}`}>
			<div
				class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-background text-base leading-none"
			>
				🪢
			</div>

			{#if !collapsed}
				<div class="min-w-0">
					<p class="truncate text-sm font-semibold tracking-tight">Cordn</p>
					<p class="truncate text-xs text-muted-foreground">Chats</p>
				</div>
			{/if}
		</div>

		{#if !collapsed}
			<Button
				type="button"
				variant="ghost"
				size="icon"
				class="h-9 w-9 shrink-0 rounded-lg"
				onclick={() => (collapsed = !collapsed)}
			>
				<ChevronLeft class="size-4" />
			</Button>
		{/if}
	</div>

	{#if collapsed}
		<Button
			type="button"
			variant="ghost"
			size="icon"
			class="mb-4 h-9 w-9 self-center rounded-lg"
			onclick={() => (collapsed = !collapsed)}
		>
			<ChevronRight class="size-4" />
		</Button>
	{/if}

	<nav class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pb-4">
		{#each chats as chat (chat.id)}
			<a
				href={getGroupHref(chat.id)}
				class={`flex items-center gap-3 rounded-xl border px-3 py-3 text-sm transition-colors ${collapsed ? 'justify-center px-2' : ''} ${isActive(getGroupHref(chat.id)) ? 'border-primary bg-primary/10 text-foreground' : 'border-transparent text-muted-foreground hover:border-border hover:bg-background hover:text-foreground'}`}
			>
				<Avatar class="h-10 w-10 shrink-0 border border-border bg-background">
					<AvatarFallback class="bg-background text-sm font-medium">{chat.icon}</AvatarFallback>
				</Avatar>

				{#if !collapsed}
					<div class="min-w-0">
						<p class="truncate font-medium">{chat.name}</p>
						<p class="truncate text-xs text-muted-foreground">Group chat</p>
					</div>
				{/if}
			</a>
		{/each}
	</nav>

	<div class="mt-auto flex flex-col gap-2 border-t border-border pt-4">
		<a
			href={resolve('/chat/config')}
			class={`flex items-center gap-3 rounded-xl border px-3 py-3 text-sm transition-colors ${collapsed ? 'justify-center px-2' : ''} ${isActive('/chat/config') ? 'border-primary bg-primary/10 text-foreground' : 'border-transparent text-muted-foreground hover:border-border hover:bg-background hover:text-foreground'}`}
		>
			<div
				class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border bg-background"
			>
				<Bolt class="size-4" />
			</div>

			{#if !collapsed}
				<div class="min-w-0">
					<p class="truncate font-medium">Config</p>
					<p class="truncate text-xs text-muted-foreground">Preferences</p>
				</div>
			{/if}
		</a>

		<div
			class={`flex items-center gap-3 rounded-xl border border-border bg-background px-3 py-3 ${collapsed ? 'justify-center' : ''}`}
		>
			<Avatar class="h-10 w-10 border border-border bg-card">
				<AvatarFallback class="bg-card text-sm font-medium">YU</AvatarFallback>
			</Avatar>

			{#if !collapsed}
				<div class="min-w-0 flex-1">
					<p class="truncate text-sm font-medium">You</p>
					<p class="truncate text-xs text-muted-foreground">Logged in</p>
				</div>
			{/if}
		</div>
	</div>
</aside>
