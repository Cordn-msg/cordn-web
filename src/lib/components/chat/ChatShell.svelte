<script lang="ts">
	import ChatComposer from './ChatComposer.svelte';
	import ChatHeader from './ChatHeader.svelte';
	import ChatMessageList from './ChatMessageList.svelte';
	import { page } from '$app/state';
	import { getChatGroupDisplayTitle } from './chatGroupDisplay';
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
		SYSTEM_MESSAGE_KIND,
		type ChatMessageDeleteTarget,
		type ChatMessageEditTarget,
		type ChatMessageReactionTarget,
		type ChatMessageReplyTarget,
		type StoredChatSystemMessageData
	} from '$lib/services/chatGroupMessages.svelte';
	import { formatUnixTimestamp, normalizePubKey } from '$lib/utils';
	import {
		getChatGroup,
		isChatGroupRemoved,
		isChatGroupPoisoned,
		listChatGroupMembers,
		listChatGroupMessages
	} from '$lib/services/chatGroups.svelte';
	import type { StoredChatMessage } from '$lib/services/chatGroupMessages.svelte';
	import { serializeChatProfileMentions } from '$lib/services/chatMentions';
	import { metadataRelays } from '$lib/services/relay-pool';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import { useProfileHints } from '$lib/services/useProfileHints.svelte';
	import { getChatDraft, setChatDraft } from '$lib/services/chatDrafts.svelte';

	let {
		groupId = 'general',
		title = 'Cordn'
	}: {
		groupId?: string;
		title?: string;
	} = $props();

	const MAX_OPTIMISTIC_MESSAGES = 20;

	// eslint-disable-next-line svelte/prefer-writable-derived -- writable $derived.by setter form not available in this Svelte version; draft must be both derived-from-storage and user-mutable via bind:value
	let draft = $state('');

	$effect(() => {
		draft = getChatDraft(groupId);
	});

	$effect(() => {
		setChatDraft(groupId, draft);
		return () => {
			setChatDraft(groupId, draft);
		};
	});
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
	let handledMessageTarget = $state('');
	const groupProfileHints = useProfileHints(
		() => [
			...new Set(
				mentionCandidates
					.map((candidate) => normalizePubKey(candidate.pubkey))
					.filter((pubkey) => pubkey && pubkey !== activePubkey)
			)
		],
		{ relays: metadataRelays }
	);
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
	const isPoisoned = $derived.by(() => isChatGroupPoisoned(group));
	const mentionCandidates = $derived.by<ChatMentionCandidate[]>(() =>
		listChatGroupMembers(groupId).map((member) => ({
			pubkey: member.stablePubkey
		}))
	);
	const displayTitle = $derived.by(() =>
		group
			? getChatGroupDisplayTitle({
					group,
					activePubkey,
					profileHints: groupProfileHints,
					memberPubkeys: mentionCandidates.map((candidate) => candidate.pubkey)
				})
			: title
	);
	const unreadReferenceTargets = $derived.by(() =>
		activePubkey ? listUnreadChatGroupReferenceTargets(groupId, activePubkey) : []
	);
	const unreadReferenceCursorByTargetId = $derived.by(() => {
		const cursors = new SvelteMap<string, number>();
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
			encrypted: message.encrypted === true,
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

	const storedMessages = $derived.by(() => listChatGroupMessages(groupId));

	// Reaction/edit/delete maps are pure functions of the stored messages.
	// Splitting them into their own $derived means Svelte only rebuilds them when
	// messages actually change — not on every optimistic edit/delete/reply which
	// only affects the `messages` derived below.
	const messageMaps = $derived.by(() => {
		const byEventId = new SvelteMap(storedMessages.map((message) => [message.id, message]));
		const reactionMap = new SvelteMap<
			string,
			SvelteMap<string, { emoji: string; authors: SvelteSet<string> }>
		>();
		const editMap = new SvelteMap<string, StoredChatMessage>();
		const deletedMessageIds = new SvelteSet<string>();

		for (const message of storedMessages) {
			const reactionReference = getMessageReactionReference(
				message.kind,
				message.content,
				message.tags
			);
			if (!reactionReference) continue;

			const byEmoji = reactionMap.get(reactionReference.targetId) ?? new SvelteMap();
			const entry = byEmoji.get(reactionReference.reaction) ?? {
				emoji: reactionReference.reaction,
				authors: new SvelteSet<string>()
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

		return { byEventId, reactionMap, editMap, deletedMessageIds };
	});

	const messages = $derived.by<ChatMessage[]>(() => {
		const { byEventId, reactionMap, editMap, deletedMessageIds } = messageMaps;

		function parseSystemMessageData(content: string): StoredChatSystemMessageData | null {
			try {
				const parsed = JSON.parse(content) as StoredChatSystemMessageData;
				if (!parsed.systemKind) return null;
				return parsed;
			} catch {
				return null;
			}
		}

		const confirmedMessages = storedMessages
			.filter((message) => message.kind !== 5 && message.kind !== 7 && message.kind !== 1010)
			.map((message) => {
				if (message.kind === SYSTEM_MESSAGE_KIND) {
					const data = parseSystemMessageData(message.content);
					return {
						...toChatMessage(message),
						text: '',
						systemKind: data?.systemKind,
						systemTarget: data?.target,
						systemCommitter: data?.committer,
						systemDetail: data?.detail
					};
				}

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

	$effect(() => {
		const targetMessage = page.url.searchParams.get('message') ?? '';
		if (!targetMessage || targetMessage === handledMessageTarget || messages.length === 0) return;

		handledMessageTarget = targetMessage;
		void messageListRef?.scrollToMessage(targetMessage);
	});
</script>

<div class="flex h-full min-h-0 flex-col bg-background text-foreground">
	<ChatHeader {groupId} title={displayTitle} />

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
	{:else if isPoisoned}
		<p
			class="mx-3 mb-3 rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive md:mx-6"
		>
			This group's local state is corrupted and cannot decrypt new messages. Contact a group admin
			to request a fresh invite.
		</p>
	{/if}

	{#if sendError || chatComposerActionsStore.error}
		<p class="px-3 pb-2 text-sm text-destructive md:px-6">{sendError}</p>
	{/if}

	<ChatComposer
		bind:value={draft}
		onSubmit={handleSubmit}
		disabled={isRemoved || isPoisoned}
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
