<script lang="ts">
	import { untrack } from 'svelte';
	import ChatComposer from './ChatComposer.svelte';
	import ChatHeader from './ChatHeader.svelte';
	import ChatMessageList from './ChatMessageList.svelte';
	import ChatPinnedRibbon from './ChatPinnedRibbon.svelte';
	import ChatDetailSidebar from './ChatDetailSidebar.svelte';
	import * as Sheet from '$lib/components/ui/sheet';
	import * as Resizable from '$lib/components/ui/resizable';
	import { IsMobile } from '$lib/hooks/is-mobile.svelte';
	import { page } from '$app/state';
	import { formatChatMessagePreviewText, getChatGroupDisplayTitle } from './chatGroupDisplay';
	import type {
		ChatMentionCandidate,
		ChatMentionReference,
		ChatMessage,
		OutgoingMediaAttachment
	} from './chat.types';
	import {
		listUnreadChatGroupReferenceTargets,
		markChatGroupMentionsRead,
		markChatGroupRead,
		getChatGroupLastReadCursor
	} from '$lib/services/chatGroupPresence.svelte';
	import {
		chatComposerActionsStore,
		castPollVoteAction,
		sendGroupMessageAction
	} from '$lib/services/chatUiActions.svelte';
	import {
		sendChatMediaMessage,
		registerMediaUpload,
		unregisterMediaUpload,
		reportMediaUpload,
		clearMediaUploadProgress
	} from '$lib/services/chatMediaStorage.svelte';
	import { type RecordingResult } from '$lib/services/voiceRecorder.svelte';
	import { manager } from '$lib/services/accountManager.svelte';
	import {
		buildAnnotationIndex,
		getMessageThreadReference,
		type ChatMessageReplyTarget,
		getMessageReactionReference,
		type MessageTarget
	} from '$lib/chat/references';
	import { emojiMapFromTags, nameOfWholeShortcode } from '$lib/chat/emoji';
	import { emojiDisplayTags, packEmojiByName } from '$lib/services/chatEmojiPacks.svelte';
	import type { ChatReactionEmojiView } from './chat.types';
	import { buildReplyQuote, unavailableReplyQuote } from '$lib/chat/replyQuote';
	import { ChatKinds, SYSTEM_MESSAGE_KIND, isStreamHiddenKind } from '$lib/chat/kinds';
	import {
		createPollMessageTags,
		describePollVote,
		getMessagePollDefinition,
		type PollDraft
	} from '$lib/chat/polls';
	import { foldReactionMarkers } from './reactionMarkers';
	import { getShowReactionMarkers } from '$lib/services/chatComposerSettings.svelte';
	import { type StoredChatSystemMessageData } from '$lib/services/chatGroupMessages.svelte';
	import { formatUnixTimestamp, normalizePubKey, samePubKey } from '$lib/utils';
	import {
		ensureChatGroupWindow,
		getChatGroup,
		isChatGroupRemoved,
		isChatGroupPoisoned,
		listChatGroupMembers,
		listChatGroupMessages,
		loadChatGroupMessagesAround,
		loadOlderChatGroupMessages
	} from '$lib/services/chatGroups.svelte';
	import type { StoredChatMessage } from '$lib/services/chatGroupMessages.svelte';
	import { serializeChatProfileMentions } from '$lib/services/chatMentions';
	import { metadataRelays } from '$lib/services/relay-pool';
	import { SvelteMap } from 'svelte/reactivity';
	import { useProfileHints } from '$lib/services/useProfileHints.svelte';
	import {
		getChatDraft,
		setChatDraft,
		getChatDraftReply,
		setChatDraftReply,
		getChatDraftEdit,
		setChatDraftEdit,
		getChatDraftMentions,
		setChatDraftMentions
	} from '$lib/services/chatDrafts.svelte';
	import {
		addPendingMessage,
		getPendingEdits,
		getPendingMessages,
		removePendingMessage,
		updatePendingMessage,
		type PendingEdit
	} from '$lib/services/chatOutbox.svelte';
	import {
		discardOutboxEntry,
		enqueueEditMessage,
		enqueueTextMessage,
		OUTBOX_ID_PREFIX,
		retryOutboxEntry
	} from '$lib/services/chatOutboxQueue';

	let {
		groupId = 'general',
		title = 'Cordn'
	}: {
		groupId?: string;
		title?: string;
	} = $props();

	let draft = $state('');

	// Restore per-group composer state on mount and group change ONLY — the map
	// reads are untracked on purpose. The save effect below writes these maps on
	// every state change, and a restore that re-ran on those writes would assign
	// fresh references (e.g. the empty mentions array) straight back into the
	// saved state: a save→restore→save effect loop that froze the UI whenever an
	// edit was armed.
	$effect(() => {
		void groupId;
		untrack(() => {
			draft = getChatDraft(groupId);
			// The armed reply, the in-progress edit and the picked mentions are
			// per-group like the draft: switching away and back must not drop them,
			// and a mid-composition remount must not silently turn an edit into a new
			// message (the reset effect below handles the other composer state).
			replyTarget = getChatDraftReply(groupId);
			const edit = getChatDraftEdit(groupId);
			editTarget = edit?.target ?? null;
			editPreview = edit?.preview ?? '';
			selectedMentions = getChatDraftMentions(groupId);
		});
	});

	$effect(() => {
		const saveComposerState = () => {
			setChatDraft(groupId, draft);
			setChatDraftReply(groupId, replyTarget);
			setChatDraftEdit(groupId, editTarget ? { target: editTarget, preview: editPreview } : null);
			setChatDraftMentions(groupId, selectedMentions);
		};
		saveComposerState();
		return saveComposerState;
	});
	let sendError = $state('');
	let replyTarget = $state<ChatMessageReplyTarget | null>(null);
	let editTarget = $state<MessageTarget | null>(null);
	let editPreview = $state('');
	let optimisticDeletes = $state<Record<string, boolean>>({});
	// Pending reactions, keyed by target eventId → emojis (optimistic overlay, like
	// optimisticDeletes: cleared on failure, superseded by the stored
	// kind-Reaction message on success — the fold's author-set union makes the
	// overlap window a no-op). Not a row, so the outbox is the wrong home.
	let optimisticReactions = $state<Record<string, string[]>>({});
	// Confirmed reactions pending their kind-5 deletion (target eventId → emojis):
	// my membership hides optimistically and reverts on send failure.
	let optimisticReactionRemovals = $state<Record<string, string[]>>({});
	let selectedMentions = $state<ChatMentionReference[]>([]);
	let composerFocusKey = $state(0);
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
	// Guarded like displayTitle: during a transient groups-store gap (boot
	// load, account switch) requireChatGroup would throw INSIDE this derived,
	// destroying the whole shell render — and with it every ephemeral composer
	// state (in-progress reply/edit target, focus). Empty candidates ride out
	// the gap instead; the shell survives and the reply is still there on send.
	const mentionCandidates = $derived.by<ChatMentionCandidate[]>(() =>
		group
			? listChatGroupMembers(groupId).map((member) => ({
					pubkey: member.stablePubkey
				}))
			: []
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
		// Sender is peer-controlled: samePubKey can't throw on a malformed sender.
		const isOwn = samePubKey(message.sender, activePubkey);
		return {
			id: `${message.id}:${message.cursor}`,
			eventId: message.id,
			author: message.sender,
			text: message.content,
			kind: message.kind,
			createdAt: message.createdAt,
			cursor: message.cursor,
			timeLabel: formatUnixTimestamp(message.createdAt, true, false),
			dayLabel: formatUnixTimestamp(message.createdAt, false, true),
			isOwn,
			deliveryState: isOwn ? 'sent' : undefined,
			unreadReference: Boolean(unreadReferenceCursor),
			unreadReferenceCursor,
			tags: message.tags,
			displayTags: message.tags,
			mediaKeyBase64: message.mediaKeyBase64,
			displayMediaKeyBase64: message.mediaKeyBase64
		};
	}

	function customReactionView(
		reaction: string,
		tags: string[][],
		mediaKeyBase64?: string
	): ChatReactionEmojiView | undefined {
		const name = nameOfWholeShortcode(reaction);
		if (!name) return undefined;
		const display = emojiMapFromTags(tags).get(name);
		if (!display) return undefined;
		return { display, mediaKeyBase64: display.media ? mediaKeyBase64 : undefined };
	}

	function optimisticReactionDisplay(reaction: string) {
		const name = nameOfWholeShortcode(reaction);
		if (!name) return undefined;
		const emoji = packEmojiByName().get(name);
		return emoji ? { name: emoji.name, url: emoji.url } : undefined;
	}

	function compareChatMessages(a: ChatMessage, b: ChatMessage): number {
		const createdAtDiff = a.createdAt - b.createdAt;
		if (createdAtDiff !== 0) {
			return createdAtDiff;
		}

		// Codepoint compare, not localeCompare: collation varies by user locale
		// and identical input must sort identically on every device.
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	}

	function appendOptimisticMessage(message: ChatMessage) {
		addPendingMessage(groupId, message);
	}

	function removeOptimisticMessage(messageId: string) {
		removePendingMessage(groupId, messageId);
	}

	function updateOptimisticMessage(
		messageId: string,
		updater: (message: ChatMessage) => ChatMessage
	) {
		updatePendingMessage(groupId, messageId, updater);
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

	// SvelteKit reuses this component across group navigation (only params.id
	// changes), so the composer's transient state would otherwise bleed into
	// the newly opened group (e.g. group A's send error shown in group B).
	// Reset it on group change. The draft text, armed reply, in-progress edit
	// and picked mentions are exempt: the effects above save and restore them
	// per group, like any other text.
	// In-flight outgoing MESSAGES are not touched here: they live in the
	// per-group outbox (chatOutbox.svelte) so they stay attached to their own
	// group while you navigate and reappear when you come back.
	$effect(() => {
		void groupId;
		sendError = '';
		optimisticDeletes = {};
		optimisticReactions = {};
		optimisticReactionRemovals = {};
	});

	const storedMessages = $derived.by(() => listChatGroupMessages(groupId));

	// Reaction/edit/delete maps are pure functions of the stored messages.
	// Splitting them into their own $derived means Svelte only rebuilds them when
	// messages actually change — not on every optimistic edit/delete/reply which
	// only affects the `messages` derived below.
	// Reaction/edit/delete index, shared with search via buildAnnotationIndex.
	// Splitting this into its own $derived means Svelte only rebuilds it when
	// messages actually change — not on every optimistic edit/delete/reply which
	// only affects the `messages` derived below.
	const messageMaps = $derived.by(() => buildAnnotationIndex(storedMessages));

	const messages = $derived.by<ChatMessage[]>(() => {
		const { byEventId, reactionMap, editMap, deletedIds, pinSet } = messageMaps;

		function parseSystemMessageData(content: string): StoredChatSystemMessageData | null {
			try {
				const parsed = JSON.parse(content) as StoredChatSystemMessageData;
				if (!parsed.systemKind) return null;
				return parsed;
			} catch {
				return null;
			}
		}

		// Reads reactive module state, so toggling the setting applies instantly.
		const reactionMarkers = getShowReactionMarkers();
		// Queued edits (durable outbox intents) overlay their target message: the
		// newest one's content is the optimistic text swap, its delivery state the
		// clock/tooltip/retry affordance on that message.
		const pendingEditByTarget = new Map<string, PendingEdit>();
		for (const pendingEdit of getPendingEdits(groupId)) {
			pendingEditByTarget.set(pendingEdit.targetId, pendingEdit);
		}
		const confirmedMessages = storedMessages
			.filter((message) =>
				message.kind === ChatKinds.Reaction ? reactionMarkers : !isStreamHiddenKind(message.kind)
			)
			.map((message) => {
				// Kind-7 reactions render as marker rows in the linear timeline
				// (systemKind 'reaction') in addition to the chips on the target.
				// Malformed references (no e/p/k tags) drop out here, mirroring the
				// chip fold. The jump target is the composite row id of the target.
				if (message.kind === ChatKinds.Reaction) {
					// Your own reactions never become timeline rows — you know what you
					// reacted to, and the chips on the message already show it. Rows are
					// for other people's activity.
					if (samePubKey(message.sender, activePubkey)) return null;
					if (deletedIds.has(message.id)) return null; // un-reacted
					const reference = getMessageReactionReference(
						message.kind,
						message.content,
						message.tags
					);
					if (!reference) return null;
					const target = byEventId.get(reference.targetId);
					const custom = customReactionView(
						reference.reaction,
						message.tags,
						message.mediaKeyBase64
					);
					return {
						...toChatMessage(message),
						text: '',
						systemKind: 'reaction',
						reactionTarget: target ? `${target.id}:${target.cursor}` : undefined,
						reactionEmojis: [reference.reaction],
						reactionEmojiViews: custom ? { [reference.reaction]: custom } : undefined,
						reactionSenders: [message.sender]
					} satisfies ChatMessage;
				}
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
				const replyPendingEdit = replySource ? pendingEditByTarget.get(replySource.id) : undefined;
				const reactions = reactionMap.get(message.id);
				const deleted = Boolean(deletedIds.has(message.id) || optimisticDeletes[message.id]);
				// Deleted rows hide their content, so their overlays go silent too —
				// a pending edit's clock has no business on a removed message.
				const pendingEdit = deleted ? undefined : pendingEditByTarget.get(message.id);
				const edit = editMap.get(message.id);
				const pinEntry = !deleted ? pinSet.get(message.id) : undefined;
				const pinned = Boolean(pinEntry && pinEntry.op === 'add');

				// Optimistic reaction overlay: union pending emojis with the stored
				// author-sets — the chip appears/highlights instantly, and the landing
				// confirmed reaction (or a concurrent peer one) can't double-count
				// (authors dedup by pubkey). Deleted targets show no chips (old ternary's
				// `!deleted && reactions : []` semantics preserved).
				// Pending removals hide my membership optimistically (count drops, chip
				// disappears at zero); the confirmed kind-5 fold takes over on ingest.
				// Direct array lookup — the fold runs for every stored message on every
				// rebuild, so no per-message Set allocation (removal lists are 0-2 entries).
				const removingMine = optimisticReactionRemovals[message.id];
				const reactionEntries = (deleted ? [] : [...(reactions ?? []).values()])
					.map((entry) => {
						const mine = Boolean(
							removingMine?.includes(entry.emoji) && entry.reactors.has(activePubkey)
						);
						const count = entry.reactors.size - (mine ? 1 : 0);
						if (count === 0) return null;
						const reactedByMe = entry.reactors.has(activePubkey) && !mine;
						return {
							emoji: entry.emoji,
							count,
							reactedByMe,
							reactors: Array.from(entry.reactors.keys()).filter(
								(pubkey) => !(mine && pubkey === activePubkey)
							),
							// If my own reaction could not carry a picture, keep drawing
							// the one this device already has instead of flicking to text.
							display:
								entry.display ?? (reactedByMe ? optimisticReactionDisplay(entry.emoji) : undefined),
							mediaKeyBase64: entry.mediaKeyBase64
						};
					})
					.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
				if (!deleted) {
					for (const emoji of optimisticReactions[message.id] ?? []) {
						const existing = reactionEntries.find((entry) => entry.emoji === emoji);
						if (existing) {
							existing.reactedByMe = true;
							if (!existing.reactors.includes(activePubkey)) {
								existing.reactors.push(activePubkey);
								existing.count += 1;
							}
						} else {
							reactionEntries.push({
								emoji,
								count: 1,
								reactedByMe: true,
								reactors: [activePubkey],
								display: optimisticReactionDisplay(emoji),
								mediaKeyBase64: undefined
							});
						}
					}
				}

				const view = toChatMessage(message);
				return {
					...view,
					deliveryState: pendingEdit?.deliveryState ?? view.deliveryState,
					deliveryDetail: pendingEdit?.deliveryDetail,
					text: deleted ? '' : (pendingEdit?.content ?? edit?.content ?? message.content),
					displayTags: pendingEdit
						? emojiDisplayTags(pendingEdit.content)
						: (edit?.tags ?? message.tags),
					displayMediaKeyBase64: pendingEdit
						? undefined
						: (edit?.mediaKeyBase64 ?? message.mediaKeyBase64),
					deleted,
					pinned,
					pinnedBy: pinned ? pinEntry?.pinnedBy : undefined,
					edited: !deleted && Boolean(pendingEdit || edit),
					reactions: reactionEntries,
					replyTo: replySource
						? buildReplyQuote({
								id: `${replySource.id}:${replySource.cursor}`,
								author: replySource.sender,
								content: deletedIds.has(replySource.id)
									? ''
									: (replyPendingEdit?.content ??
										editMap.get(replySource.id)?.content ??
										replySource.content),
								deleted: deletedIds.has(replySource.id),
								tags: replyPendingEdit
									? emojiDisplayTags(replyPendingEdit.content)
									: (editMap.get(replySource.id)?.tags ?? replySource.tags),
								mediaKeyBase64: replyPendingEdit
									? undefined
									: (editMap.get(replySource.id)?.mediaKeyBase64 ?? replySource.mediaKeyBase64)
							})
						: threadReference
							? unavailableReplyQuote(threadReference.parentId, threadReference.parentPubkey)
							: undefined
				};
			});

		// Never render a pending bubble whose confirmed copy is already
		// ingested (the live subscription echoes our own send back, and backlog
		// confirms land while the entry is still queued): the pending→confirmed
		// swap happens in a single render instead of a both-visible flash.
		// Unsealed bubbles carry `outbox:` event ids, which never match.
		const pending = getPendingMessages(groupId).filter(
			(message) => !byEventId.has(message.eventId)
		);
		return foldReactionMarkers(
			[...confirmedMessages, ...pending]
				.filter((message): message is ChatMessage => message !== null)
				.sort(compareChatMessages)
		);
	});

	// Ordered pin list for the top ribbon. Newest-pinned-first; resolves the
	// derived pin set against the rendered view models so previews reuse the
	// edit-resolved text. O(messages) once per message change, O(pins) to resolve.
	const pinnedMessages = $derived.by<ChatMessage[]>(() => {
		const { pinSet } = messageMaps;
		// Common case: no pins — skip the O(messages) view-model map entirely.
		if (pinSet.size === 0) return [];
		const byEventId = new SvelteMap<string, ChatMessage>();
		for (const message of messages) byEventId.set(message.eventId, message);

		const entries = [...pinSet.values()]
			.filter((entry) => entry.op === 'add')
			.sort((a, b) => b.pinnedAt - a.pinnedAt || b.cursor - a.cursor);

		const result: ChatMessage[] = [];
		for (const entry of entries) {
			const message = byEventId.get(entry.targetId);
			if (message && !message.deleted) result.push(message);
		}
		return result;
	});

	const composerReplyPreview = $derived.by(() =>
		replyTarget
			? {
					author: replyTarget.pubkey,
					// No raw `nostr:npub…` wire tokens in the chip — resolve to @Name like
					// the sidebar previews do.
					text: formatChatMessagePreviewText(replyTarget.content, groupProfileHints)
				}
			: null
	);

	async function handleSubmit() {
		if (!draft.trim() || !group) {
			return;
		}

		if (editTarget) {
			const serialized = serializeChatProfileMentions(draft.trim(), selectedMentions);
			const currentEditTarget = editTarget;
			draft = '';
			selectedMentions = [];
			clearEditTarget();

			// Edits ride the durable outbox like text sends: the intent is
			// persisted before any network attempt and drained when back online,
			// projected as the optimistic text swap + clock on the target message.
			enqueueEditMessage({
				groupId,
				target: currentEditTarget,
				content: serialized.content,
				tags: serialized.tags
			});
			return;
		}

		const serialized = serializeChatProfileMentions(draft.trim(), selectedMentions);
		const currentReplyTarget = replyTarget;

		// Text sends go through the durable outbox: the intent is persisted before
		// any network attempt, so it survives reload/close/offline and drains
		// (FIFO per group) once a connection is available. The optimistic bubble is
		// added synchronously inside enqueueTextMessage.
		enqueueTextMessage({
			groupId,
			content: serialized.content,
			tags: serialized.tags,
			replyTo: currentReplyTarget ?? undefined
		});

		await messageListRef?.scrollToBottom();

		draft = '';
		selectedMentions = [];
		clearReplyTarget();
		// Reassert composer focus so the soft keyboard stays open for the next message (mobile chat
		// UX). The scroll + re-render above can blur the textarea and dismiss the keyboard; bumping
		// focusKey here re-focuses it before the network send resolves, minimizing flicker (also
		// keeps the cursor in the composer on desktop).
		composerFocusKey += 1;
	}

	/** Poll sends enqueue like text (durable outbox-first) with their validated
	 *  option tags and the resolved kind; the dialog has already validated the
	 *  draft so createPollMessageTags cannot throw here. */
	function handleSendPoll(pollDraft: PollDraft) {
		// Re-validate on send: the draft's deadline is checked against the clock at
		// enqueue time too, so surface that (rare) failure like any other send error.
		try {
			enqueueTextMessage({
				groupId,
				content: pollDraft.question,
				tags: createPollMessageTags(pollDraft),
				kind: ChatKinds.Poll
			});
		} catch (error) {
			sendError = error instanceof Error ? error.message : 'Failed to create poll';
			return;
		}
		void messageListRef?.scrollToBottom();
		composerFocusKey += 1;
	}

	function handleSendMedia(entries: OutgoingMediaAttachment[]) {
		if (!group || entries.length === 0) return;
		const currentReplyTarget = replyTarget;
		const optimisticReplyTarget = buildOptimisticReplyView();
		// Fan out one optimistic message per file: one `imeta` per MLS message is
		// the existing model, so each file uploads + sends independently — a slow
		// or large file never blocks the others, and partial failures are
		// per-message. Each file carries its own caption (the composer draft
		// captions the first). Mentions serialize per caption (same as the text
		// path): only labels actually present in that caption become `nostr:npub…`
		// + p tags, so the chip renders and the mentioned person gets their ping.
		// The reply still rides the first file only: one reply per send, not one
		// per file.
		entries.forEach((entry, index) => {
			const serialized = serializeChatProfileMentions(entry.caption.trim(), selectedMentions);
			sendOneMedia(
				entry.file,
				serialized.content,
				serialized.tags,
				index === 0 ? (currentReplyTarget ?? undefined) : undefined,
				index === 0 ? optimisticReplyTarget : undefined
			);
		});

		// Consume the caption + draft so the composer is immediately free for the
		// next message (mirrors the text-send reset). The reply chip clears when
		// the reply-carrying send lands (sendOneMedia) — media sends aren't
		// outbox-backed, so clearing here would drop the reply on failure.
		draft = '';
		selectedMentions = [];
	}

	function sendOneMedia(
		file: File,
		text: string,
		tags: string[][],
		replyTo?: ChatMessageReplyTarget,
		optimisticReplyTo?: ChatMessage['replyTo']
	) {
		const isImage = file.type.startsWith('image/');
		const createdAt = Date.now();
		const optimisticId = `optimistic:${crypto.randomUUID()}`;
		const previewUrl = isImage ? URL.createObjectURL(file) : undefined;

		appendOptimisticMessage({
			id: optimisticId,
			eventId: optimisticId,
			author: activePubkey,
			text,
			kind: ChatKinds.Text,
			createdAt,
			timeLabel: formatUnixTimestamp(createdAt, true, false),
			dayLabel: formatUnixTimestamp(createdAt, false, true),
			isOwn: true,
			deliveryState: 'sending',
			replyTo: optimisticReplyTo,
			displayTags: emojiDisplayTags(text),
			media: {
				mime: file.type || 'application/octet-stream',
				filename: file.name,
				sizeBytes: file.size,
				previewUrl
			}
		});

		void messageListRef?.scrollToBottom();

		// One AbortController per upload, registered so the uploading message's
		// cancel button (in ChatMessageMedia) can abort it by optimistic id
		// without a callback drilled through the message list.
		const controller = new AbortController();
		registerMediaUpload(optimisticId, controller);

		// Fire-and-forget: the upload + sealed send runs in the background so the
		// composer stays free. The optimistic item shows the local preview + a
		// progress bar (driven by `onProgress`); on success it's replaced by the
		// confirmed message, on failure it flips to 'error' (preview retained).
		sendChatMediaMessage({
			groupId,
			file,
			text,
			tags,
			replyTo,
			onProgress: (percent, phase) => reportMediaUpload(optimisticId, percent, phase),
			signal: controller.signal
		})
			.then(() => {
				removeOptimisticMessage(optimisticId);
				if (previewUrl) URL.revokeObjectURL(previewUrl);
				// The reply rode this message (first file): consume the chip now that
				// it landed — identity compare so a reply re-armed meanwhile (a fresh
				// object, even for the same parent) is never consumed. ponytail: a
				// send landing after switching groups leaves that group's chip armed
				// on return (visible, so a duplicate send is obvious); clear the
				// stored entry by send-group id if it ever matters.
				if (replyTo && replyTarget === replyTo) clearReplyTarget();
			})
			.catch((error) => {
				// User cancelled: drop the optimistic bubble silently (no error state,
				// no toast). The file is already gone from the composer, so retrying
				// means re-picking — same as any major messenger's cancel.
				if (controller.signal.aborted) {
					removeOptimisticMessage(optimisticId);
					if (previewUrl) URL.revokeObjectURL(previewUrl);
					return;
				}
				console.error('Failed to send media:', error);
				chatComposerActionsStore.error =
					error instanceof Error ? error.message : 'Failed to send media';
				updateOptimisticMessage(optimisticId, (message) => ({
					...message,
					deliveryState: 'error'
				}));
			})
			.finally(() => {
				unregisterMediaUpload(optimisticId);
				clearMediaUploadProgress(optimisticId);
			});
	}

	function sendVoiceMessage(result: RecordingResult, text: string, tags: string[][]) {
		const createdAt = Date.now();
		const optimisticId = `optimistic:${crypto.randomUUID()}`;
		// Audio needs a local URL too (not just images) so the optimistic player can
		// play the just-recorded clip before the upload resolves.
		const previewUrl = URL.createObjectURL(result.file);
		const currentReplyTarget = replyTarget;
		const optimisticReplyTarget = buildOptimisticReplyView();

		appendOptimisticMessage({
			id: optimisticId,
			eventId: optimisticId,
			author: activePubkey,
			text,
			kind: ChatKinds.Text,
			createdAt,
			timeLabel: formatUnixTimestamp(createdAt, true, false),
			dayLabel: formatUnixTimestamp(createdAt, false, true),
			isOwn: true,
			deliveryState: 'sending',
			replyTo: optimisticReplyTarget,
			displayTags: emojiDisplayTags(text),
			media: {
				mime: result.mime,
				filename: result.file.name,
				sizeBytes: result.file.size,
				previewUrl,
				durationMs: result.durationMs,
				waveform: result.peaks
			}
		});

		void messageListRef?.scrollToBottom();

		const controller = new AbortController();
		registerMediaUpload(optimisticId, controller);

		sendChatMediaMessage({
			groupId,
			file: result.file,
			text,
			tags,
			replyTo: currentReplyTarget ?? undefined,
			voice: { durationMs: result.durationMs, waveform: result.peaks },
			onProgress: (percent, phase) => reportMediaUpload(optimisticId, percent, phase),
			signal: controller.signal
		})
			.then(() => {
				removeOptimisticMessage(optimisticId);
				URL.revokeObjectURL(previewUrl);
				// The voice note carried the reply (first-and-only message): consume
				// the chip now that it landed — identity compare, same rule as
				// sendOneMedia.
				if (currentReplyTarget && replyTarget === currentReplyTarget) clearReplyTarget();
			})
			.catch((error) => {
				if (controller.signal.aborted) {
					removeOptimisticMessage(optimisticId);
					URL.revokeObjectURL(previewUrl);
					return;
				}
				console.error('Failed to send voice note:', error);
				chatComposerActionsStore.error =
					error instanceof Error ? error.message : 'Failed to send voice note';
				updateOptimisticMessage(optimisticId, (message) => ({
					...message,
					deliveryState: 'error'
				}));
			})
			.finally(() => {
				unregisterMediaUpload(optimisticId);
				clearMediaUploadProgress(optimisticId);
			});
	}

	function handleSendVoice(result: RecordingResult) {
		if (!group) return;
		// Same mention serialization as the media caption (rides as the voice
		// note's text).
		const serialized = serializeChatProfileMentions(draft.trim(), selectedMentions);
		sendVoiceMessage(result, serialized.content, serialized.tags);
		draft = '';
		selectedMentions = [];
	}

	async function handleRetrySend(message: ChatMessage) {
		if (!group) return;

		// A failed queued edit rides on its confirmed target message — retry its
		// intent like any other failed send. Several failed edits on one target
		// retry together (drained FIFO, so the newest content lands last).
		const failedEdits = getPendingEdits(groupId).filter(
			(edit) => edit.targetId === message.eventId && edit.deliveryState === 'error'
		);
		if (failedEdits.length > 0) {
			for (const edit of failedEdits) retryOutboxEntry(edit.id);
			return;
		}

		// Media sends can't be retried from the bubble: the original File isn't
		// retained (only a preview URL), so a text-path retry would fire an empty
		// or caption-only message with the media dropped. Remove the failed bubble
		// instead — re-pick to retry, same exit as cancel-during-upload.
		if (message.media) {
			if (message.media.previewUrl) URL.revokeObjectURL(message.media.previewUrl);
			removeOptimisticMessage(message.id);
			return;
		}

		// Queued text messages retry through the outbox (resets backoff, kicks
		// the drain). The reply target is already persisted on the entry.
		retryOutboxEntry(message.id);
	}

	function handleReply(message: ChatMessage) {
		if (message.deleted) return;

		const storedMessage = messageMaps.byEventId.get(message.eventId);
		if (!storedMessage) return;

		replyTarget = {
			id: storedMessage.id,
			pubkey: storedMessage.sender,
			kind: storedMessage.kind,
			content: storedMessage.content,
			tags: storedMessage.tags,
			mediaKeyBase64: storedMessage.mediaKeyBase64
		};
		composerFocusKey += 1;
	}

	function clearReplyTarget() {
		replyTarget = null;
	}

	/** Bubble-shaped reply view for optimistic messages (same builder as the
	 *  confirmed mapping in `messages`); shared by the media and voice sends. */
	function buildOptimisticReplyView(): ChatMessage['replyTo'] {
		if (!replyTarget) return undefined;
		return buildReplyQuote({
			id: replyTarget.id,
			author: replyTarget.pubkey,
			content: replyTarget.content,
			tags: replyTarget.tags,
			mediaKeyBase64: replyTarget.mediaKeyBase64
		});
	}

	function clearEditTarget() {
		editTarget = null;
		editPreview = '';
	}

	async function handleReact(message: ChatMessage, reaction: string) {
		if (message.deleted) return;

		const storedMessage = messageMaps.byEventId.get(message.eventId);
		if (!storedMessage) return;

		const reactionTarget: MessageTarget = {
			id: storedMessage.id,
			pubkey: storedMessage.sender,
			kind: storedMessage.kind
		};

		// Optimistic: show the chip immediately. On success the stored kind-Reaction
		// message takes over (author-set union — no flicker, no double count); on
		// failure the overlay entry is dropped so the chip reverts, with the composer
		// error surfacing why (same UX as optimistic deletes). Double-taps are
		// harmless: the annotation fold dedups by author pubkey.
		const currentTarget = storedMessage.id;
		optimisticReactions = {
			...optimisticReactions,
			[currentTarget]: [...(optimisticReactions[currentTarget] ?? []), reaction]
		};

		const sent = await sendGroupMessageAction(groupId, reaction, undefined, reactionTarget);
		sendError = chatComposerActionsStore.error;
		if (!sent) {
			const next = { ...optimisticReactions };
			const emojis = (next[currentTarget] ?? []).filter((emoji) => emoji !== reaction);
			if (emojis.length === 0) delete next[currentTarget];
			else next[currentTarget] = emojis;
			optimisticReactions = next;
		}
	}

	/** Poll votes mirror reactions: best-effort send, error surfaced to the
	 *  composer error row. The poll row keeps its optimistic selection until the
	 *  confirmed kind-1018 ingests (one vote per account, latest wins). */
	async function handleVote(message: ChatMessage, optionIds: string[]) {
		const storedMessage = messageMaps.byEventId.get(message.eventId);
		if (!storedMessage || storedMessage.kind !== ChatKinds.Poll) return false;

		const voteTarget: MessageTarget = {
			id: storedMessage.id,
			pubkey: storedMessage.sender,
			kind: storedMessage.kind
		};
		// Pre-poll clients render `content` as the bubble text, so send the voted
		// labels along (updated clients ignore it — the tally reads tags only).
		const definition = getMessagePollDefinition(
			storedMessage.kind,
			storedMessage.content,
			storedMessage.tags
		);
		const sent = await castPollVoteAction(
			groupId,
			voteTarget,
			optionIds,
			describePollVote(definition, optionIds)
		);
		sendError = chatComposerActionsStore.error;
		return Boolean(sent);
	}

	async function handleUnreact(message: ChatMessage, emoji: string) {
		if (message.deleted) return;
		const storedMessage = messageMaps.byEventId.get(message.eventId);
		if (!storedMessage) return;
		const currentTarget = storedMessage.id;

		// Un-reacting an add still in flight just drops the overlay. If the
		// kind-7 already reached the server, the chip reappears when its
		// confirmed copy ingests (one more tap removes it for good) — the
		// same accepted double-tap race as handleReact.
		const pendingAdds = optimisticReactions[currentTarget] ?? [];
		if (pendingAdds.includes(emoji)) {
			const next = { ...optimisticReactions };
			const emojis = pendingAdds.filter((pending) => pending !== emoji);
			if (emojis.length === 0) delete next[currentTarget];
			else next[currentTarget] = emojis;
			optimisticReactions = next;
			return;
		}

		const mine = messageMaps.reactionMap.get(currentTarget)?.get(emoji)?.reactors.get(activePubkey);
		if (!mine?.size) return;

		optimisticReactionRemovals = {
			...optimisticReactionRemovals,
			[currentTarget]: [...(optimisticReactionRemovals[currentTarget] ?? []), emoji]
		};
		const revert = () => {
			const next = { ...optimisticReactionRemovals };
			const emojis = (next[currentTarget] ?? []).filter((pending) => pending !== emoji);
			if (emojis.length === 0) delete next[currentTarget];
			else next[currentTarget] = emojis;
			optimisticReactionRemovals = next;
		};

		// One kind-5 per reaction event (reacting from several devices leaves
		// several ids); a single failure reverts the optimistic hide.
		let allSent = true;
		for (const eventId of mine) {
			const deleteTarget: MessageTarget = {
				id: eventId,
				pubkey: activePubkey,
				kind: ChatKinds.Reaction
			};
			const sent = await sendGroupMessageAction(
				groupId,
				'',
				undefined,
				undefined,
				[],
				undefined,
				deleteTarget
			);
			allSent = allSent && Boolean(sent);
		}
		sendError = chatComposerActionsStore.error;
		if (!allSent) revert();
	}

	function handleEdit(message: ChatMessage) {
		if (message.deleted) return;

		const storedMessage = messageMaps.byEventId.get(message.eventId);
		if (!storedMessage || !samePubKey(storedMessage.sender, activePubkey)) return;

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

		// Pending outbox bubbles have no stored message to send a kind-5 for —
		// "delete" on a wedged/failed bubble discards the send intent instead
		// (safe for ambiguous entries: a landed copy still arrives via ingest).
		if (message.id.startsWith(OUTBOX_ID_PREFIX)) {
			discardOutboxEntry(message.id);
			return;
		}

		const storedMessage = messageMaps.byEventId.get(message.eventId);
		if (!storedMessage || !samePubKey(storedMessage.sender, activePubkey)) return;

		const deleteTarget: MessageTarget = {
			id: storedMessage.id,
			pubkey: storedMessage.sender,
			kind: storedMessage.kind
		};

		setOptimisticDelete(deleteTarget.id);
		await sendGroupMessageAction(groupId, '', undefined, undefined, [], undefined, deleteTarget);
		sendError = chatComposerActionsStore.error;
		clearOptimisticDelete(deleteTarget.id);
	}

	async function handlePin(message: ChatMessage) {
		if (message.deleted) return;

		const storedMessage = messageMaps.byEventId.get(message.eventId);
		if (!storedMessage) return;

		const target: MessageTarget = {
			id: storedMessage.id,
			pubkey: storedMessage.sender,
			kind: storedMessage.kind
		};

		await sendGroupMessageAction(
			groupId,
			'',
			undefined,
			undefined,
			[],
			undefined,
			undefined,
			target,
			message.pinned ? 'remove' : 'add'
		);
		sendError = chatComposerActionsStore.error;
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

	let selectedDetailEventId = $state<string | null>(null);
	// File drag-and-drop onto the chat surface → staged in the composer for
	// review (same as the `+` menu). Web-oriented; harmless on native.
	let composerRef = $state<{ addFiles: (files: File[]) => void } | null>(null);
	let dragOver = $state(false);
	const isMobile = new IsMobile();
	// ponytail: object ref, not $state. PaneForge's defaultSize is reactive, so
	// feeding a $state back creates a drag loop that snaps the pane back. A
	// plain object isn't tracked by Svelte, so onResize records silently and the
	// prop doesn't re-render mid-drag; remount re-reads it so the last dragged
	// size still restores across close/open in the session.
	const detailSizeRef = { current: 40 };

	function handleOpenRich(eventId: string) {
		selectedDetailEventId = eventId;
	}

	function handleJumpToMessage(targetEventId: string) {
		const target = messages.find((m) => m.eventId === targetEventId);
		if (target) void messageListRef?.scrollToMessage(target.id);
		// On mobile the sidebar overlays the chat, so the scrolled message isn't
		// visible behind it — close so the user sees the jump. Desktop keeps it open.
		if (isMobile.current) selectedDetailEventId = null;
	}

	function handleCloseRich() {
		selectedDetailEventId = null;
	}

	// Open-at-first-unread: which rendered row the list should land on when the
	// chat opens. Computed during render (not in an effect) so the message list
	// mounts with the focus cursor already in hand — an effect-set prop arrives
	// one flush late, the list bottom-pins first, and that in-flight pin keeps
	// the virtual window at the tail so the focus row never renders. Snapshotted
	// once per group; the read cursor only advances with visibility, so the
	// unread gap persists until actually read and a mid-backlog exit resumes
	// here next open. Live arrivals while the chat is open never re-focus. A
	// ?message= deep link wins (its own effect scrolls to the target).
	// Windowed history (docs/long-history.md decision 6): when the unread gap
	// starts below the loaded window, focus the gap start and let the list load
	// its page before landing.
	let snapshotGroupId = '';
	let snapshotFocusCursor = 0;
	const initialFocusCursor = $derived.by(() => {
		if (snapshotGroupId !== groupId) {
			snapshotGroupId = groupId;
			const lastReadCursor = getChatGroupLastReadCursor(groupId);
			const unreadExists = Boolean(group && group.lastCursor > lastReadCursor);
			if (page.url.searchParams.get('message') || !unreadExists) {
				snapshotFocusCursor = 0;
			} else {
				const firstUnread = storedMessages.find(
					(message) =>
						message.cursor > lastReadCursor &&
						message.kind !== SYSTEM_MESSAGE_KIND &&
						!isStreamHiddenKind(message.kind)
				);
				const windowFloor = storedMessages[0]?.cursor ?? Infinity;
				snapshotFocusCursor = firstUnread
					? firstUnread.cursor
					: windowFloor > lastReadCursor
						? lastReadCursor + 1
						: 0;
			}
		}
		return snapshotFocusCursor;
	});

	// Read-marking follows visibility (Signal-Desktop-style): the message list
	// reports the highest cursor actually on screen, so a backlog survives a
	// partial read — close mid-scroll and the unread marker resumes where you
	// left it. At the bottom the report means mark-everything instead: rows
	// can't see annotations folded into other rows, and everything above has
	// been scrolled past anyway.
	function handleVisibleRead({ cursor, atBottom }: { cursor: number; atBottom: boolean }) {
		if (!groupId) return;
		if (atBottom) markChatGroupRead(groupId);
		else markChatGroupRead(groupId, cursor);
	}

	$effect(() => {
		const targetMessage = page.url.searchParams.get('message') ?? '';
		if (!targetMessage || targetMessage === handledMessageTarget || messages.length === 0) return;
		if (!messageListRef) return; // wait for the list to mount before claiming handled
		handledMessageTarget = targetMessage;
		void messageListRef.scrollToMessage(targetMessage);
	});

	// Grow the open group's window to the full tail (docs/long-history.md).
	$effect(() => {
		if (!groupId) return;
		untrack(() => void ensureChatGroupWindow(groupId));
	});
</script>

{#snippet chatColumn()}
	<!-- File drop zone: a pointer-only enhancement over the composer's "…" file
	     picker (the accessible equivalent), so no ARIA role is attached. -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="flex h-full min-h-0 min-w-0 flex-col"
		class:ring-2={dragOver}
		class:ring-primary={dragOver}
		class:ring-inset={dragOver}
		ondragover={(event) => {
			if (event.dataTransfer?.types.includes('Files')) {
				event.preventDefault();
				dragOver = true;
			}
		}}
		ondragleave={(event) => {
			// Only clear when the pointer leaves the chat surface (dragleave fires
			// for child elements too).
			if (!event.currentTarget.contains(event.relatedTarget as Node | null)) dragOver = false;
		}}
		ondrop={(event) => {
			event.preventDefault();
			dragOver = false;
			composerRef?.addFiles(Array.from(event.dataTransfer?.files ?? []));
		}}
	>
		<ChatHeader {groupId} title={displayTitle} />

		{#if pinnedMessages.length > 0}
			<ChatPinnedRibbon
				messages={pinnedMessages}
				onJumpToMessage={(id) => messageListRef?.scrollToMessage(id)}
				onUnpin={handlePin}
			/>
		{/if}

		<div class="min-h-0 flex-1">
			{#if messages.length === 0}
				<div
					class="flex h-full items-center justify-center px-6 pb-10 text-center"
					aria-live="polite"
				>
					<p class="max-w-sm text-sm text-muted-foreground">No messages yet — say hi 👋</p>
				</div>
			{:else}
				<ChatMessageList
					bind:this={messageListRef}
					{messages}
					{groupId}
					{initialFocusCursor}
					ensureMessage={(cursor) => loadChatGroupMessagesAround(groupId, cursor)}
					onLoadOlder={() => loadOlderChatGroupMessages(groupId)}
					unreadReferenceCount={unreadReferenceTargets.length}
					onNavigateToReference={navigateToNextReference}
					onReply={handleReply}
					onReact={handleReact}
					onUnreact={handleUnreact}
					onEdit={handleEdit}
					onDelete={handleDelete}
					onRetrySend={handleRetrySend}
					onVisibleUnreadReference={handleVisibleUnreadReference}
					onVisibleRead={handleVisibleRead}
					onOpenRich={handleOpenRich}
					onPin={handlePin}
					onVote={handleVote}
				/>
			{/if}
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
			bind:this={composerRef}
			bind:value={draft}
			onSubmit={handleSubmit}
			onSendMedia={handleSendMedia}
			onSendVoice={handleSendVoice}
			onSendPoll={handleSendPoll}
			disabled={isRemoved || isPoisoned}
			replyTo={composerReplyPreview}
			editTo={editTarget
				? { text: formatChatMessagePreviewText(editPreview, groupProfileHints) }
				: null}
			onCancelReply={clearReplyTarget}
			onCancelEdit={clearEditTarget}
			focusKey={composerFocusKey}
			{mentionCandidates}
			bind:selectedMentions
		/>
	</div>
{/snippet}

{#if isMobile.current}
	<div class="h-full bg-background text-foreground">
		{@render chatColumn()}
	</div>

	{#if selectedDetailEventId}
		<Sheet.Root
			bind:open={
				() => selectedDetailEventId !== null,
				(open) => {
					if (!open) handleCloseRich();
				}
			}
		>
			<Sheet.Content
				side="right"
				showCloseButton={false}
				class="bg-background data-[side=right]:w-full"
			>
				<ChatDetailSidebar
					{groupId}
					eventId={selectedDetailEventId}
					onClose={handleCloseRich}
					onNavigate={handleOpenRich}
					onJumpToMessage={handleJumpToMessage}
				/>
			</Sheet.Content>
		</Sheet.Root>
	{/if}
{:else}
	<Resizable.PaneGroup direction="horizontal" class="h-full w-full bg-background text-foreground">
		<Resizable.Pane order={1} defaultSize={60} minSize={30} class="min-w-0 overflow-hidden">
			{@render chatColumn()}
		</Resizable.Pane>
		{#if selectedDetailEventId}
			<Resizable.Handle withHandle />
			<Resizable.Pane
				order={2}
				defaultSize={detailSizeRef.current}
				minSize={20}
				maxSize={70}
				onResize={(size) => (detailSizeRef.current = size)}
			>
				<ChatDetailSidebar
					{groupId}
					eventId={selectedDetailEventId}
					onClose={handleCloseRich}
					onNavigate={handleOpenRich}
					onJumpToMessage={handleJumpToMessage}
				/>
			</Resizable.Pane>
		{/if}
	</Resizable.PaneGroup>
{/if}
