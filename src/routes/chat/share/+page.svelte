<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import ChatGroupListItem from '$lib/components/chat/ChatGroupListItem.svelte';
	import ChatMobileSidebarButton from '$lib/components/chat/ChatMobileSidebarButton.svelte';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import Share2 from '@lucide/svelte/icons/share-2';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import { listChatGroups } from '$lib/services/chatGroups.svelte';
	import { getChatGroupSummary } from '$lib/services/chatGroupPresence.svelte';
	import { getGroupActivityAt } from '$lib/components/chat/chatGroupDisplay';
	import { setChatDraft } from '$lib/services/chatDrafts.svelte';
	import { consumeStashedShare, isNativePlatform } from '$lib/services/nativeBridge';

	let { data } = $props();

	// Web transport fills `data.text` via the share_target GET params (+page.ts load).
	// Native transport fills it here: nativeBridge stashed the SEND-intent text, then navigated here.
	let shareText = $state<string | null>(null);
	let resolved = $state(false);

	onMount(() => {
		// Read both transports once on mount: web params from route load data, native from the stash.
		let text = data.text ?? null;
		if (text === null && isNativePlatform()) {
			const stashed = consumeStashedShare();
			if (stashed?.kind === 'text') text = stashed.text;
		}
		shareText = text;
		resolved = true;
		// ponytail: the "already on /chat/share, share again" foreground edge is not handled —
		// a same-URL goto is a no-op so onMount won't re-run. Rare enough for v1; re-share works
		// on cold start and on foreground-from-any-other-page.
		if (!shareText?.trim()) {
			void goto(resolve('/chat'));
		}
	});

	const groups = $derived.by(() => listChatGroups());
	const sortedGroups = $derived.by(() =>
		[...groups].sort((a, b) => getGroupActivityAt(b) - getGroupActivityAt(a))
	);

	function getGroupHref(groupId: string) {
		return resolve('/chat/[id]', { id: groupId });
	}

	// Drop the shared text into the target group's draft. The <a href> then navigates; ChatShell
	// reads getChatDraft(groupId) on mount, so the shared text lands in the composer for review.
	function selectGroup(groupId: string) {
		if (!shareText) return;
		setChatDraft(groupId, shareText);
	}
</script>

<svelte:head>
	<title>Share to… | Cordn</title>
</svelte:head>

<div class="flex h-full min-h-0 flex-col bg-background text-foreground">
	<header class="border-b border-border bg-background/95 px-4 py-4 backdrop-blur md:px-6">
		<div class="mx-auto flex w-full max-w-3xl items-start gap-3">
			<ChatMobileSidebarButton />
			<div class="min-w-0 flex-1 space-y-1">
				<h1 class="flex items-center gap-2 text-xl font-semibold tracking-tight">
					<Share2 class="size-5 text-muted-foreground" />
					Share to…
				</h1>
				<p class="truncate text-sm text-muted-foreground">Pick a group to send it to.</p>
			</div>
		</div>
	</header>

	<div class="flex-1 overflow-y-auto px-4 py-6 md:px-6 md:py-8">
		<div class="mx-auto flex max-w-3xl flex-col gap-6">
			{#if !resolved || !shareText?.trim()}
				<!-- resolving the transport, or redirecting to /chat (nothing to share) -->
			{:else}
				<div class="rounded-2xl border border-border bg-muted/30 p-4">
					<p class="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
						Sharing
					</p>
					<p class="line-clamp-6 text-sm break-words whitespace-pre-wrap text-foreground">
						{shareText}
					</p>
				</div>

				{#if !$activeAccount}
					<div
						class="rounded-2xl border border-dashed border-border p-4 text-sm text-muted-foreground"
					>
						Connect an account before sharing into a group.
					</div>
				{:else if sortedGroups.length === 0}
					<div class="space-y-3 rounded-2xl border border-dashed border-border p-4">
						<p class="text-sm text-muted-foreground">
							You don't have any groups yet. Create one to share into.
						</p>
						<Button href={resolve('/chat/create-group')}>Create group</Button>
					</div>
				{:else}
					<Card.Root>
						<Card.Header>
							<Card.Title>Choose a group</Card.Title>
							<Card.Description>
								The shared text becomes a draft you can review and edit before sending.
							</Card.Description>
						</Card.Header>
						<Card.Content class="space-y-3">
							{#each sortedGroups as group (group.id)}
								{@const summary = getChatGroupSummary(group.id, $activeAccount?.pubkey)}
								<ChatGroupListItem
									{group}
									href={getGroupHref(group.id)}
									preview={summary.preview}
									unreadCount={summary.unreadCount}
									unreadReferenceCount={summary.unreadReferenceCount}
									onclick={() => selectGroup(group.id)}
								/>
							{/each}
						</Card.Content>
					</Card.Root>
				{/if}
			{/if}
		</div>
	</div>
</div>
