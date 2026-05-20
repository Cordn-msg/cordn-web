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
	import {
		getMessageReactionReference,
		getMessageThreadReference,
		type ChatMessageReactionTarget,
		type ChatMessageReplyTarget
	} from '$lib/services/chatGroupMessages.svelte';
	import { formatUnixTimestamp, normalizePubKey } from '$lib/utils';
	import {
		getChatGroup,
		isChatGroupRemoved,
		listChatGroupMessages
	} from '$lib/services/chatGroups.svelte';

	let {
		groupId = 'general',
		title = 'Cordn',
		subtitle = 'Private group chat'
	}: {
		groupId?: string;
		title?: string;
		subtitle?: string;
	} = $props();

	let draft = $state('');
	let sendError = $state('');
	let replyTarget = $state<ChatMessageReplyTarget | null>(null);
	let replyTargetAuthor = $state('');
	let composerFocusKey = $state(0);
	const activePubkey = $derived.by(() => {
		const pubkey = manager.getActive()?.pubkey;
		return pubkey ? normalizePubKey(pubkey) : '';
	});
	const group = $derived.by(() => getChatGroup(groupId));
	const isRemoved = $derived.by(() => isChatGroupRemoved(group));
	const messages = $derived.by<ChatMessage[]>(() => {
		const storedMessages = listChatGroupMessages(groupId);
		const byEventId = new Map(storedMessages.map((message) => [message.id, message]));
		const reactionMap = new Map<string, Map<string, { emoji: string; authors: Set<string> }>>();

		for (const message of storedMessages) {
			const reactionReference = getMessageReactionReference(
				message.kind,
				message.content,
				message.tags
			);
			if (!reactionReference) continue;

			const byEmoji = reactionMap.get(reactionReference.targetId) ?? new Map();
			const entry = byEmoji.get(reactionReference.reaction) ?? {
				emoji: reactionReference.reaction,
				authors: new Set<string>()
			};

			entry.authors.add(normalizePubKey(message.sender));
			byEmoji.set(reactionReference.reaction, entry);
			reactionMap.set(reactionReference.targetId, byEmoji);
		}

		return storedMessages
			.filter((message) => message.kind !== 7)
			.map((message) => {
				const threadReference = getMessageThreadReference(message.tags);
				const replySource = threadReference ? byEventId.get(threadReference.parentId) : undefined;
				const reactions = reactionMap.get(message.id);

				return {
					id: `${message.id}:${message.cursor}`,
					eventId: message.id,
					author: message.sender,
					text: message.content,
					timeLabel: formatUnixTimestamp(message.createdAt, true, false),
					dayLabel: formatUnixTimestamp(message.createdAt, false, true),
					isOwn: normalizePubKey(message.sender) === activePubkey,
					reactions: reactions
						? Array.from(reactions.values()).map((entry) => ({
								emoji: entry.emoji,
								count: entry.authors.size,
								reactedByMe: entry.authors.has(activePubkey),
								reactors: Array.from(entry.authors)
							}))
						: [],
					replyTo: replySource
						? {
								id: `${replySource.id}:${replySource.cursor}`,
								author: replySource.sender,
								text: replySource.content
							}
						: undefined
				};
			});
	});

	const composerReplyPreview = $derived.by(() =>
		replyTarget
			? {
					author: replyTarget.pubkey,
					authorLabel: replyTargetAuthor || replyTarget.pubkey,
					text: replyTarget.content
				}
			: null
	);

	async function handleSubmit() {
		if (!draft.trim() || !group) {
			return;
		}
		const sent = await sendGroupMessageAction(groupId, draft, replyTarget ?? undefined);
		sendError = chatComposerActionsStore.error;
		if (sent) {
			draft = '';
			clearReplyTarget();
		}
	}

	function handleReply(message: ChatMessage) {
		const storedMessage = listChatGroupMessages(groupId).find(
			(entry) => entry.id === message.eventId
		);
		if (!storedMessage) return;

		replyTarget = {
			id: storedMessage.id,
			pubkey: storedMessage.sender,
			kind: storedMessage.kind,
			content: storedMessage.content,
			tags: storedMessage.tags
		};
		replyTargetAuthor = message.author;
		composerFocusKey += 1;
	}

	function clearReplyTarget() {
		replyTarget = null;
		replyTargetAuthor = '';
	}

	async function handleReact(message: ChatMessage, reaction: string) {
		const storedMessage = listChatGroupMessages(groupId).find(
			(entry) => entry.id === message.eventId
		);
		if (!storedMessage) return;

		const reactionTarget: ChatMessageReactionTarget = {
			id: storedMessage.id,
			pubkey: storedMessage.sender,
			kind: storedMessage.kind
		};

		await sendGroupMessageAction(groupId, reaction, undefined, reactionTarget);
		sendError = chatComposerActionsStore.error;
	}

	$effect(() => {
		if (!groupId || !group) return;
		markChatGroupRead(groupId, group.lastCursor);
	});
</script>

<div class="flex h-full min-h-0 flex-col bg-background text-foreground">
	<ChatHeader
		{groupId}
		{title}
		{subtitle}
		icon={group?.metadata?.icon}
		imageUrl={group?.metadata?.imageUrl}
	/>

	<div class="min-h-0 flex-1">
		<ChatMessageList {messages} onReply={handleReply} onReact={handleReact} />
	</div>

	{#if isRemoved}
		<p
			class="mx-3 mb-3 rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive md:mx-6"
		>
			You were removed from this group. This local copy is now read-only. Open the info page to
			delete it from this device.
		</p>
	{/if}

	{#if sendError || chatComposerActionsStore.error}
		<p class="px-3 pb-2 text-sm text-destructive md:px-6">{sendError}</p>
	{/if}

	<ChatComposer
		bind:value={draft}
		onSubmit={handleSubmit}
		disabled={isRemoved}
		replyTo={composerReplyPreview}
		onCancelReply={clearReplyTarget}
		focusKey={composerFocusKey}
	/>
</div>
