<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';

	import ChatHeader from '$lib/components/chat/ChatHeader.svelte';
	import ChatMobileSidebarButton from '$lib/components/chat/ChatMobileSidebarButton.svelte';
	import GroupCalendar from '$lib/components/chat/GroupCalendar.svelte';
	import GroupSectionNav from '$lib/components/chat/GroupSectionNav.svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { getChatGroup } from '$lib/services/chatGroups.svelte';
	import { groupRouteId } from '$lib/services/chatGroupLinks.svelte';
	import { resolveGroupLocator } from '$lib/utils/groupShareLink';

	let { params } = $props();

	const locator = $derived(resolveGroupLocator(params.id, page.url.searchParams));
	const group = $derived.by(() => getChatGroup(locator.gid));
	const chatHref = $derived(resolve('/chat/[id]', { id: groupRouteId(locator.gid) }));
</script>

<svelte:head>
	<meta name="description" content="Cordn group calendar." />
</svelte:head>

{#if group}
	<div class="flex h-full min-h-0 flex-col bg-background text-foreground">
		<ChatHeader groupId={group.id} title={group.metadata?.name || 'Chat'} />
		<GroupSectionNav groupId={group.id} active="calendar" />
		<div class="min-h-0 flex-1">
			<GroupCalendar groupId={group.id} />
		</div>
	</div>
{:else}
	<div class="flex h-full min-h-0 flex-col bg-background text-foreground">
		<div class="flex items-center px-4 py-3">
			<ChatMobileSidebarButton />
		</div>
		<div class="flex flex-1 items-center justify-center px-4 py-12">
			<Card.Root class="w-full max-w-md">
				<Card.Header>
					<Card.Title>Calendar</Card.Title>
					<Card.Description>You are not a member of this group yet.</Card.Description>
				</Card.Header>
				<Card.Content>
					<Button href={chatHref} class="w-full">Open the group</Button>
				</Card.Content>
			</Card.Root>
		</div>
	</div>
{/if}
