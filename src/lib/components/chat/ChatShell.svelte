<script lang="ts">
	import ChatComposer from './ChatComposer.svelte';
	import ChatHeader from './ChatHeader.svelte';
	import ChatMessageList from './ChatMessageList.svelte';
	import type { ChatMessage } from './chat.types';
	import { markChatGroupRead } from '$lib/services/chatGroupPresence.svelte';
	import {
		chatComposerActionsStore,
		sendGroupMessageAction
	} from '$lib/services/chatUiActions.svelte';
	import { manager } from '$lib/services/accountManager.svelte';
	import { formatUnixTimestamp, normalizePubKey } from '$lib/utils';
	import {
		getChatGroup,
		isChatGroupRemoved,
		listChatGroupMessages
	} from '$lib/services/chatGroups.svelte';

	let {
		groupId = 'general',
		title = 'Cordn',
		subtitle = 'Coordinator-assisted messaging'
	}: {
		groupId?: string;
		title?: string;
		subtitle?: string;
	} = $props();

	let draft = $state('');
	let sendError = $state('');
	const activePubkey = $derived.by(() => {
		const pubkey = manager.getActive()?.pubkey;
		return pubkey ? normalizePubKey(pubkey) : '';
	});
	const group = $derived.by(() => getChatGroup(groupId));
	const isRemoved = $derived.by(() => isChatGroupRemoved(group));
	const messages = $derived.by<ChatMessage[]>(() =>
		listChatGroupMessages(groupId).map((message) => ({
			id: `${message.id}:${message.cursor}`,
			author: message.sender,
			text: message.content,
			timestamp: formatUnixTimestamp(message.createdAt, true),
			timeLabel: formatUnixTimestamp(message.createdAt, true, false),
			dayLabel: formatUnixTimestamp(message.createdAt, false, true),
			isOwn: normalizePubKey(message.sender) === activePubkey
		}))
	);

	async function handleSubmit() {
		if (!draft.trim() || !group) {
			return;
		}
		const sent = await sendGroupMessageAction(groupId, draft);
		sendError = chatComposerActionsStore.error;
		if (sent) {
			draft = '';
		}
	}

	$effect(() => {
		if (!groupId || !group) return;
		markChatGroupRead(groupId, group.lastCursor);
	});
</script>

<div class="flex h-full min-h-0 flex-col bg-background text-foreground">
	<ChatHeader {groupId} {title} {subtitle} icon={group?.metadata?.icon} />

	<div class="min-h-0 flex-1">
		<ChatMessageList {messages} />
	</div>

	{#if isRemoved}
		<p
			class="mx-4 mb-3 rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive md:mx-6"
		>
			You were removed from this group. This local copy is now read-only. Open the info page to
			delete it from this device.
		</p>
	{/if}

	{#if sendError || chatComposerActionsStore.error}
		<p class="px-4 pb-2 text-sm text-destructive md:px-6">{sendError}</p>
	{/if}

	<ChatComposer bind:value={draft} onSubmit={handleSubmit} disabled={isRemoved} />
</div>
