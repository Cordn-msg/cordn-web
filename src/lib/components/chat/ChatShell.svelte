<script lang="ts">
	import ChatComposer from './ChatComposer.svelte';
	import ChatHeader from './ChatHeader.svelte';
	import ChatMessageList from './ChatMessageList.svelte';
	import type { ChatMentionCandidate, ChatMentionReference, ChatMessage } from './chat.types';
	import {
		listUnreadChatGroupReferenceTargets,
		markChatGroupMentionsRead,
		markChatGroupRead
	} from '$lib/services/chatGroupPresence.svelte';
	import {
		chatComposerActionsStore,
		sendGroupMessageAction
	} from '$lib/services/chatUiActions.svelte';
	import { manager } from '$lib/services/accountManager.svelte';
	import {
		getMessageDeleteReference,
		getMessageEditReference,
		getMessageReactionReference,
		getMessageThreadReference,
		type ChatMessageDeleteTarget,
		type ChatMessageEditTarget,
		type ChatMessageReactionTarget,
		type ChatMessageReplyTarget
	} from '$lib/services/chatGroupMessages.svelte';
	import { formatUnixTimestamp, normalizePubKey } from '$lib/utils';
	import {
		getChatGroup,
		isChatGroupRemoved,
		listChatGroupMembers,
		listChatGroupMessages
	} from '$lib/services/chatGroups.svelte';
	import type { StoredChatMessage } from '$lib/services/chatGroupMessages.svelte';
	import { serializeChatProfileMentions } from '$lib/services/chatMentions';

	let {
		groupId = 'general',
		title = 'Cordn',
		subtitle = 'Private group chat'
	}: {
		groupId?: string;
		title?: string;
		subtitle?: string;
	} = $props();

	const MAX_OPTIMISTIC_MESSAGES = 20;

	let draft = $state('');
	let sendError = $state('');
	let replyTarget = $state<ChatMessageReplyTarget | null>(null);
	let replyTargetAuthor = $state('');
	let editTarget = $state<ChatMessageEditTarget | null>(null);
	let editPreview = $state('');
	let optimisticEdits = $state<Record<string, string>>({});
	let optimisticDeletes = $state<Record<string, boolean>>({});
	let selectedMentions = $state<ChatMentionReference[]>([]);
	let composerFocusKey = $state(0);
	let optimisticMessages = $state<ChatMessage[]>([]);
	let optimisticMessageSequence = 0;
	let messageListRef: {
		scrollToBottom: () => Promise<void>;
		scrollToMessage: (messageId: string) => Promise<void>;
	} | null = $state(null);
	const activePubkey = $derived.by(() => {
		const pubkey = manager.getActive()?.pubkey;
		return pubkey ? normalizePubKey(pubkey) : '';
	});
	const group = $derived.by(() => getChatGroup(groupId));
	const isRemoved = $derived.by(() => isChatGroupRemoved(group));
	const mentionCandidates = $derived.by<ChatMentionCandidate[]>(() =>
		listChatGroupMembers(groupId).map((member) => ({
			pubkey: member.stablePubkey
		}))
	);
	const unreadReferenceTargets = $derived.by(() =>
		activePubkey ? listUnreadChatGroupReferenceTargets(groupId, activePubkey) : []
	);
	const unreadReferenceCursorByTargetId = $derived.by(() => {
		const cursors = new Map<string, number>();
		for (const entry of unreadReferenceTargets) {
			const current = cursors.get(entry.target.id) ?? 0;
			if (entry.reference.cursor > current) {
				cursors.set(entry.target.id, entry.reference.cursor);
			}
		}
		return cursors;
	});
	function toChatMessage(message: StoredChatMessage): ChatMessage {
		const unreadReferenceCursor = unreadReferenceCursorByTargetId.get(message.id);
		return {
			id: `${message.id}:${message.cursor}`,
			eventId: message.id,
			author: message.sender,
			text: message.content,
			createdAt: message.createdAt,
			cursor: message.cursor,
			timeLabel: formatUnixTimestamp(message.createdAt, true, false),
			dayLabel: formatUnixTimestamp(message.createdAt, false, true),
			isOwn: normalizePubKey(message.sender) === activePubkey,
			deliveryState: normalizePubKey(message.sender) === activePubkey ? 'sent' : undefined,
			unreadReference: Boolean(unreadReferenceCursor),
			unreadReferenceCursor
		};
	}

	function compareChatMessages(a: ChatMessage, b: ChatMessage): number {
		const createdAtDiff = a.createdAt - b.createdAt;
		if (createdAtDiff !== 0) {
			return createdAtDiff;
		}

		return a.id.localeCompare(b.id);
	}

	function appendOptimisticMessage(message: ChatMessage) {
		setOptimisticMessages([...optimisticMessages, message]);
	}

	function removeOptimisticMessage(messageId: string) {
		optimisticMessages = optimisticMessages.filter((message) => message.id !== messageId);
	}

	function updateOptimisticMessage(
		messageId: string,
		updater: (message: ChatMessage) => ChatMessage
	) {
		setOptimisticMessages(
			optimisticMessages.map((message) => (message.id === messageId ? updater(message) : message))
		);
	}

	function setOptimisticEdit(messageId: string, content: string) {
		optimisticEdits = {
			...optimisticEdits,
			[messageId]: content
		};
	}

	function clearOptimisticEdit(messageId: string) {
		const next = { ...optimisticEdits };
		delete next[messageId];
		optimisticEdits = next;
	}

	function setOptimisticDelete(messageId: string) {
		optimisticDeletes = {
			...optimisticDeletes,
			[messageId]: true
		};
	}

	function clearOptimisticDelete(messageId: string) {
		const next = { ...optimisticDeletes };
		delete next[messageId];
		optimisticDeletes = next;
	}

	const messages = $derived.by<ChatMessage[]>(() => {
		const storedMessages = listChatGroupMessages(groupId);
		const byEventId = new Map(storedMessages.map((message) => [message.id, message]));
		const reactionMap = new Map<string, Map<string, { emoji: string; authors: Set<string> }>>();
		const editMap = new Map<string, StoredChatMessage>();
		const deletedMessageIds = new Set<string>();

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

		for (const message of storedMessages) {
			const deleteReference = getMessageDeleteReference(message.kind, message.tags);
			if (!deleteReference) continue;

			const original = byEventId.get(deleteReference.targetId);
			if (!original) continue;
			if (deleteReference.targetKind !== original.kind) continue;
			if (normalizePubKey(original.sender) !== normalizePubKey(message.sender)) continue;

			deletedMessageIds.add(deleteReference.targetId);
		}

		for (const message of storedMessages) {
			const editReference = getMessageEditReference(message.kind, message.content, message.tags);
			if (!editReference) continue;
			if (deletedMessageIds.has(editReference.targetId)) continue;

			const original = byEventId.get(editReference.targetId);
			if (!original) continue;
			if (normalizePubKey(original.sender) !== normalizePubKey(message.sender)) continue;

			const current = editMap.get(editReference.targetId);
			if (!current || message.createdAt > current.createdAt) {
				editMap.set(editReference.targetId, message);
			}
		}

		const confirmedMessages = storedMessages
			.filter((message) => message.kind !== 5 && message.kind !== 7 && message.kind !== 1010)
			.map((message) => {
				const threadReference = getMessageThreadReference(message.tags);
				const replySource = threadReference ? byEventId.get(threadReference.parentId) : undefined;
				const reactions = reactionMap.get(message.id);
				const optimisticEdit = optimisticEdits[message.id];
				const edit = editMap.get(message.id);
				const deleted = Boolean(deletedMessageIds.has(message.id) || optimisticDeletes[message.id]);

				return {
					...toChatMessage(message),
					text: deleted ? '' : (optimisticEdit ?? edit?.content ?? message.content),
					deleted,
					edited: !deleted && Boolean(optimisticEdit || edit),
					reactions:
						!deleted && reactions
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

		return [...confirmedMessages, ...optimisticMessages].sort(compareChatMessages);
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

	function setOptimisticMessages(messages: ChatMessage[]) {
		optimisticMessages = messages.slice(-MAX_OPTIMISTIC_MESSAGES);
	}

	async function handleSubmit() {
		if (!draft.trim() || !group) {
			return;
		}

		if (editTarget) {
			const serialized = serializeChatProfileMentions(draft.trim(), selectedMentions);
			const currentEditTarget = editTarget;
			setOptimisticEdit(currentEditTarget.id, serialized.content);
			draft = '';
			selectedMentions = [];
			clearEditTarget();

			await sendGroupMessageAction(
				groupId,
				serialized.content,
				undefined,
				undefined,
				serialized.tags,
				currentEditTarget
			);
			sendError = chatComposerActionsStore.error;
			clearOptimisticEdit(currentEditTarget.id);
			return;
		}

		const serialized = serializeChatProfileMentions(draft.trim(), selectedMentions);
		const messageText = serialized.content;
		const currentReplyTarget = replyTarget;
		const currentReplyTargetAuthor = replyTargetAuthor;
		const optimisticCreatedAt = Date.now();
		const optimisticId = `optimistic:${groupId}:${optimisticMessageSequence++}`;
		const optimisticReplyTarget = currentReplyTarget
			? {
					id: currentReplyTarget.id,
					author: currentReplyTarget.pubkey,
					authorLabel: currentReplyTargetAuthor || currentReplyTarget.pubkey,
					text: currentReplyTarget.content
				}
			: undefined;

		appendOptimisticMessage({
			id: optimisticId,
			eventId: optimisticId,
			author: activePubkey,
			text: messageText,
			createdAt: optimisticCreatedAt,
			timeLabel: formatUnixTimestamp(optimisticCreatedAt, true, false),
			dayLabel: formatUnixTimestamp(optimisticCreatedAt, false, true),
			isOwn: true,
			deliveryState: 'sending',
			reactions: [],
			replyTo: optimisticReplyTarget
		});

		await messageListRef?.scrollToBottom();

		draft = '';
		selectedMentions = [];
		clearReplyTarget();

		const sent = await sendGroupMessageAction(
			groupId,
			messageText,
			currentReplyTarget ?? undefined,
			undefined,
			serialized.tags
		);
		sendError = chatComposerActionsStore.error;

		if (sent) {
			removeOptimisticMessage(optimisticId);
			return;
		}

		updateOptimisticMessage(optimisticId, (message) => ({ ...message, deliveryState: 'error' }));
	}

	function handleReply(message: ChatMessage) {
		if (message.deleted) return;

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

	function clearEditTarget() {
		editTarget = null;
		editPreview = '';
	}

	async function handleReact(message: ChatMessage, reaction: string) {
		if (message.deleted) return;

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

	function handleEdit(message: ChatMessage) {
		if (message.deleted) return;

		const storedMessage = listChatGroupMessages(groupId).find(
			(entry) => entry.id === message.eventId
		);
		if (!storedMessage || normalizePubKey(storedMessage.sender) !== activePubkey) return;

		editTarget = {
			id: storedMessage.id,
			pubkey: storedMessage.sender,
			kind: storedMessage.kind
		};
		editPreview = message.text;
		draft = message.text;
		selectedMentions = [];
		clearReplyTarget();
		composerFocusKey += 1;
	}

	async function handleDelete(message: ChatMessage) {
		if (message.deleted) return;

		const storedMessage = listChatGroupMessages(groupId).find(
			(entry) => entry.id === message.eventId
		);
		if (!storedMessage || normalizePubKey(storedMessage.sender) !== activePubkey) return;

		const deleteTarget: ChatMessageDeleteTarget = {
			id: storedMessage.id,
			pubkey: storedMessage.sender,
			kind: storedMessage.kind
		};

		setOptimisticDelete(deleteTarget.id);
		await sendGroupMessageAction(groupId, '', undefined, undefined, [], undefined, deleteTarget);
		sendError = chatComposerActionsStore.error;
		clearOptimisticDelete(deleteTarget.id);
	}

	async function navigateToNextReference() {
		const [nextReference] = unreadReferenceTargets;
		if (!nextReference) return;

		await messageListRef?.scrollToMessage(
			`${nextReference.target.id}:${nextReference.target.cursor}`
		);
		markChatGroupMentionsRead(groupId, nextReference.reference.cursor);
	}

	function handleVisibleUnreadReference(message: ChatMessage) {
		if (!message.unreadReferenceCursor) return;
		markChatGroupMentionsRead(groupId, message.unreadReferenceCursor);
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
		<ChatMessageList
			bind:this={messageListRef}
			{messages}
			onReply={handleReply}
			onReact={handleReact}
			onEdit={handleEdit}
			onDelete={handleDelete}
			onVisibleUnreadReference={handleVisibleUnreadReference}
		/>
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
		editTo={editTarget ? { text: editPreview } : null}
		onCancelReply={clearReplyTarget}
		onCancelEdit={clearEditTarget}
		focusKey={composerFocusKey}
		{mentionCandidates}
		bind:selectedMentions
		unreadReferenceCount={unreadReferenceTargets.length}
		onNavigateToReference={navigateToNextReference}
	/>
</div>
