<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import { Textarea } from '$lib/components/ui/textarea';
	import { addressLoader } from '$lib/services/loaders.svelte';
	import { metadataRelays } from '$lib/services/relay-pool';
	import { capturePhoto, captureVideo, pickImagesFromGallery } from '$lib/services/nativeShims';
	import { formatBytes, formatClock } from '$lib/utils';
	import {
		createVoiceRecorder,
		isVoiceRecordingSupported,
		type RecordingResult
	} from '$lib/services/voiceRecorder.svelte';
	import { toast } from 'svelte-sonner';
	import ChevronUp from '@lucide/svelte/icons/chevron-up';
	import AtSign from '@lucide/svelte/icons/at-sign';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Reply from '@lucide/svelte/icons/reply';
	import SendHorizontal from '@lucide/svelte/icons/send-horizontal';
	import X from '@lucide/svelte/icons/x';
	import Paperclip from '@lucide/svelte/icons/paperclip';
	import Mic from '@lucide/svelte/icons/mic';
	import Lock from '@lucide/svelte/icons/lock';
	import Trash from '@lucide/svelte/icons/trash-2';
	import ChevronLeft from '@lucide/svelte/icons/chevron-left';
	import ChatComposerActions from './ChatComposerActions.svelte';
	import { Metadata } from 'nostr-tools/kinds';
	import { nip19 } from 'nostr-tools';
	import ProfileCard from '../ProfileCard.svelte';
	import type { ChatMentionCandidate, ChatMentionReference } from './chat.types';
	import { useProfileHints } from '$lib/services/useProfileHints.svelte';

	const COMPOSER_PREVIEW_WRAP_CLASS =
		'line-clamp-2 min-w-0 max-w-full text-sm whitespace-pre-wrap break-words [overflow-wrap:anywhere] [word-break:break-word]';
	const COMPOSER_INPUT_WRAP_CLASS =
		'field-sizing-fixed min-h-11 w-full min-w-0 max-w-full overflow-x-hidden whitespace-pre-wrap break-words rounded-xl border border-input bg-card text-sm shadow-xs [overflow-wrap:anywhere] [word-break:break-word]';

	let {
		value = $bindable(''),
		onSubmit,
		disabled = false,
		replyTo = null,
		editTo = null,
		onCancelReply = () => {},
		onCancelEdit = () => {},
		focusKey = 0,
		mentionCandidates = [],
		selectedMentions = $bindable([]),
		unreadReferenceCount = 0,
		onNavigateToReference = () => {},
		onSendMedia = () => {},
		onSendVoice = () => {}
	}: {
		value?: string;
		onSubmit: () => void;
		disabled?: boolean;
		replyTo?: { author: string; authorLabel?: string; text: string } | null;
		editTo?: { text: string } | null;
		onCancelReply?: () => void;
		onCancelEdit?: () => void;
		focusKey?: number;
		mentionCandidates?: ChatMentionCandidate[];
		selectedMentions?: ChatMentionReference[];
		unreadReferenceCount?: number;
		onNavigateToReference?: () => void | Promise<void>;
		/** Send media files (with the current draft as caption). */
		onSendMedia?: (files: File[], caption: string) => void;
		/** Send a recorded voice note. The composer drives the recorder UX; this
		 *  fires on release, on a locked-recording send tap, or on a silence-VAD
		 *  auto-stop. */
		onSendVoice?: (result: RecordingResult) => void;
	} = $props();

	let textareaRef: HTMLTextAreaElement | null = $state(null);
	let expanded = $state(false);

	// Staged media attachments: added via the `+` menu (gallery, camera capture, or documents),
	// sent on submit with the current draft as caption. Each holds a File plus a preview object URL
	// for images; URLs are revoked on remove/send so they never leak. Each staged file becomes its
	// own message at send time (one `imeta` per MLS message is the existing model).
	interface StagedAttachment {
		readonly id: string;
		readonly file: File;
		readonly previewUrl: string;
	}
	let pendingAttachments = $state<StagedAttachment[]>([]);

	// Voice-note recorder. Created once; send happens only via explicit
	// gestures/buttons (release-to-send, drag-up-to-lock, trash to cancel) — there
	// is no silence auto-stop, so `onSendVoice` is read at call time in each handler.
	const recorder = createVoiceRecorder();
	const voiceSupported = isVoiceRecordingSupported();
	const isRecording = $derived(
		recorder.state === 'recording' || recorder.state === 'locked' || recorder.state === 'requesting'
	);
	const showMic = $derived(
		!disabled && voiceSupported && !value.trim() && pendingAttachments.length === 0 && !isRecording
	);

	// Hold-to-record gesture tracking. Listeners attach to window on pointerdown
	// so the gesture survives even though the mic button is hidden while the
	// recording bar is showing. LOCK = drag up (hands-free); CANCEL = drag left.
	// `dragUpPx`/`dragLeftPx` feed the lock/cancel target highlights and the
	// record-button icon crossfade, so the user sees where each direction leads.
	let activePointerId: number | null = null;
	let gestureStartX = 0;
	let gestureStartY = 0;
	let dragLocked = false;
	let dragUpPx = $state(0);
	let dragLeftPx = $state(0);
	// Gesture thresholds scaled to the viewport so they're equally reachable on
	// phones and tablets, not fixed pixels that feel too long on small screens.
	// Computed once at init — a recording session is too short for a resize or
	// rotation mid-gesture to matter. ponytail: clamped so extreme aspect ratios
	// stay sane; revisit if a specific device feels off.
	const LOCK_PX = Math.min(120, Math.max(56, Math.round(window.innerHeight * 0.1)));
	const CANCEL_PX = Math.min(140, Math.max(48, Math.round(window.innerWidth * 0.3)));
	const lockProgress = $derived(Math.min(1, dragUpPx / LOCK_PX));
	const cancelProgress = $derived(Math.min(1, dragLeftPx / CANCEL_PX));

	function beginGesture(event: PointerEvent) {
		activePointerId = event.pointerId;
		gestureStartX = event.clientX;
		gestureStartY = event.clientY;
		dragLocked = false;
		dragUpPx = 0;
		dragLeftPx = 0;
		// Touch implicitly captures the pointer to the pointerdown target (the mic
		// button), which unmounts the instant recording begins — that orphaned
		// capture would swallow pointerup/pointermove and strand the recording on
		// phones. Re-capture on <body> (never unmounts) so the gesture survives the
		// DOM swap and release/drag keep working. Mouse has no implicit capture, so
		// this is a harmless no-op on desktop.
		try {
			document.body.setPointerCapture(event.pointerId);
		} catch {
			/* setPointerCapture unsupported — window listeners are the fallback */
		}
		window.addEventListener('pointermove', onGestureMove);
		window.addEventListener('pointerup', onGestureEnd);
		window.addEventListener('pointercancel', onGestureEnd);
	}

	function startVoice(event: PointerEvent) {
		if (event.pointerType === 'mouse' && event.button !== 0) return;
		if (recorder.state !== 'idle' && recorder.state !== 'error') return;
		// Always engage the hold gesture. If a native permission dialog appears
		// (first-ever use) the recorder self-detects the getUserMedia delay and
		// starts hands-free (locked) instead, where send/trash buttons are
		// reachable — the system dialog would otherwise orphan the pointer gesture.
		beginGesture(event);
		void recorder.start();
	}

	function onGestureMove(event: PointerEvent) {
		if (event.pointerId !== activePointerId) return;
		if (recorder.state !== 'recording') return;
		dragUpPx = Math.max(0, gestureStartY - event.clientY);
		dragLeftPx = Math.max(0, gestureStartX - event.clientX);
		if (dragUpPx > LOCK_PX && !dragLocked) {
			dragLocked = true;
			recorder.lock();
		} else if (dragLeftPx > CANCEL_PX) {
			endGesture();
			void recorder.cancel();
		}
	}

	async function onGestureEnd(event: PointerEvent) {
		if (event.pointerId !== activePointerId) return;
		endGesture();
		const s = recorder.state;
		if (s === 'recording') {
			const result = await recorder.stop();
			if (result) onSendVoice(result);
		} else if (s === 'requesting') {
			// Released while still acquiring (granted-permission slow path) — abort.
			void recorder.cancel();
		}
	}

	function endGesture() {
		if (activePointerId !== null) {
			try {
				document.body.releasePointerCapture(activePointerId);
			} catch {
				/* nothing captured / already released */
			}
		}
		activePointerId = null;
		dragUpPx = 0;
		dragLeftPx = 0;
		window.removeEventListener('pointermove', onGestureMove);
		window.removeEventListener('pointerup', onGestureEnd);
		window.removeEventListener('pointercancel', onGestureEnd);
	}

	async function finishLockedRecording() {
		const result = await recorder.stop();
		if (result) onSendVoice(result);
	}

	function cancelRecording() {
		void recorder.cancel();
	}

	$effect(() => {
		const s = recorder.state;
		if (s === 'error') {
			toast.error('Voice recording failed', { description: recorder.error ?? undefined });
		}
		// Release any held pointer capture + gesture listeners once recording
		// settles — covers the locked-cancel and permission-denied paths where no
		// pointerup ever fires (and the dialog-orphaned first-use case).
		if (s === 'error' || s === 'idle') endGesture();
	});

	// Debounce the "Waiting for microphone…" placeholder: a granted mic resolves
	// getUserMedia in a few frames, so surfacing `requesting` immediately flashes
	// it on every record. Only show it if the request genuinely lingers (a slow
	// grant or a native permission dialog) — keeps tap-to-record feeling snappy.
	let requestingVisible = $state(false);
	let requestingTimer: ReturnType<typeof setTimeout> | undefined;
	$effect(() => {
		if (recorder.state === 'requesting') {
			requestingTimer = setTimeout(() => (requestingVisible = true), 200);
		} else {
			if (requestingTimer) clearTimeout(requestingTimer);
			requestingVisible = false;
		}
	});

	onDestroy(() => {
		if (requestingTimer) clearTimeout(requestingTimer);
		endGesture();
		recorder.destroy();
	});

	let documentInputRef: HTMLInputElement | null = $state(null);
	let mentionQuery = $state('');
	let mentionStart = $state(-1);
	let highlightedMentionIndex = $state(0);
	const profileHints = useProfileHints(() =>
		mentionCandidates.map((candidate) => candidate.pubkey)
	);

	const activeMention = $derived(mentionStart >= 0);
	const mentionMatches = $derived.by(() => {
		if (!activeMention) return [];
		const query = mentionQuery.toLowerCase();
		if (!query) return mentionCandidates.slice(0, 6);
		return mentionCandidates
			.map((candidate) => {
				const profile = profileHints[candidate.pubkey];
				const npub = nip19.npubEncode(candidate.pubkey);
				const values = [
					candidate.name || profile?.name,
					candidate.displayName || profile?.displayName,
					candidate.nip05 || profile?.nip05,
					candidate.pubkey,
					npub
				].filter((value): value is string => Boolean(value));
				const exactPrefix = values.some((value) => value.toLowerCase().startsWith(query));
				const includes = values.some((value) => value.toLowerCase().includes(query));
				return { candidate, score: exactPrefix ? 0 : includes ? 1 : 2 };
			})
			.filter((entry) => entry.score < 2)
			.sort((a, b) => a.score - b.score)
			.slice(0, 6)
			.map((entry) => entry.candidate);
	});

	function getMentionLabel(candidate: ChatMentionCandidate) {
		const profile = profileHints[candidate.pubkey];
		const npub = nip19.npubEncode(candidate.pubkey);
		return (
			candidate.name ||
			profile?.name ||
			candidate.displayName ||
			profile?.displayName ||
			candidate.nip05 ||
			profile?.nip05 ||
			`${npub.slice(0, 12)}…`
		);
	}

	function getMentionHint(candidate: ChatMentionCandidate) {
		const profile = profileHints[candidate.pubkey];
		return candidate.nip05 || profile?.nip05 || nip19.npubEncode(candidate.pubkey);
	}

	function handleSubmit(event: Event) {
		event.preventDefault();
		if (disabled) return;
		dispatchSubmit();
	}

	// Shared by the form submit (button) and the Enter-key shortcut so a pending
	// attachment is honored by BOTH paths — otherwise Enter with text + an image
	// would silently send only the text.
	function dispatchSubmit() {
		if (pendingAttachments.length > 0) {
			const files = pendingAttachments.map((attachment) => attachment.file);
			const caption = value;
			clearAttachments();
			onSendMedia(files, caption);
			return;
		}
		onSubmit();
	}

	function handleKeyDown(event: KeyboardEvent) {
		if (disabled) return;
		if (activeMention && mentionMatches.length > 0) {
			if (event.key === 'ArrowDown') {
				event.preventDefault();
				highlightedMentionIndex = (highlightedMentionIndex + 1) % mentionMatches.length;
				return;
			}
			if (event.key === 'ArrowUp') {
				event.preventDefault();
				highlightedMentionIndex =
					(highlightedMentionIndex - 1 + mentionMatches.length) % mentionMatches.length;
				return;
			}
			if (event.key === 'Enter' || event.key === 'Tab') {
				event.preventDefault();
				selectMention(mentionMatches[highlightedMentionIndex]);
				return;
			}
			if (event.key === 'Escape') {
				event.preventDefault();
				closeMentionDialog();
				return;
			}
		}
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			dispatchSubmit();
		}
	}

	function handleInput(event: Event) {
		updateMentionState(event.currentTarget as HTMLTextAreaElement);
		requestAnimationFrame(() => resizeTextarea());
	}

	function updateMentionState(target: HTMLTextAreaElement) {
		const caret = target.selectionStart;
		const beforeCaret = value.slice(0, caret);
		const match = /(^|\s)@([^\s@]*)$/.exec(beforeCaret);
		if (!match) {
			closeMentionDialog();
			return;
		}
		mentionStart = beforeCaret.length - match[2].length - 1;
		mentionQuery = match[2];
		highlightedMentionIndex = 0;
	}

	function closeMentionDialog() {
		mentionStart = -1;
		mentionQuery = '';
		highlightedMentionIndex = 0;
	}

	function selectMention(candidate: ChatMentionCandidate) {
		if (!textareaRef || mentionStart < 0) return;
		const label = getMentionLabel(candidate).replace(/\s+/g, '');
		const caret = textareaRef.selectionStart;
		const beforeMention = value.slice(0, mentionStart);
		const afterMention = value.slice(caret).replace(/^\s*/, '');
		const nextValue = `${beforeMention}@${label} ${afterMention}`;
		value = nextValue;
		selectedMentions = [
			...selectedMentions.filter((mention) => mention.pubkey !== candidate.pubkey),
			{ pubkey: candidate.pubkey, label }
		];
		closeMentionDialog();
		queueMicrotask(() => {
			if (!textareaRef) return;
			const nextCaret = beforeMention.length + label.length + 2;
			textareaRef.focus();
			textareaRef.setSelectionRange(nextCaret, nextCaret);
			resizeTextarea();
		});
	}

	function stageFiles(files: File[]) {
		for (const file of files) {
			pendingAttachments = [
				...pendingAttachments,
				{
					id: crypto.randomUUID(),
					file,
					previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : ''
				}
			];
		}
	}

	// Photo and video capture share one path — both @capacitor/camera methods yield a single File the
	// composer stages identically — so a tiny helper removes the duplicated try/stage/toast body.
	async function captureAndStage(capture: () => Promise<File | null>) {
		try {
			const file = await capture();
			if (file) stageFiles([file]);
		} catch (err) {
			toast.error('Could not open camera', {
				description: err instanceof Error ? err.message : String(err)
			});
		}
	}

	function takePhoto() {
		void captureAndStage(capturePhoto);
	}

	function takeVideo() {
		void captureAndStage(captureVideo);
	}

	async function pickImage() {
		try {
			const files = await pickImagesFromGallery();
			if (files.length > 0) stageFiles(files);
		} catch (err) {
			toast.error('Could not open gallery', {
				description: err instanceof Error ? err.message : String(err)
			});
		}
	}

	function pickDocument() {
		documentInputRef?.click();
	}

	function handleFileSelected(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		// Snapshot the File objects BEFORE clearing the input: `input.files` is a
		// LIVE FileList, so `input.value = ''` empties it. `File` objects themselves
		// survive the reset, hence `Array.from` first (mirrors the old
		// `input.files?.[0]` read-then-clear order).
		const files = input.files ? Array.from(input.files) : [];
		input.value = '';
		if (files.length === 0) return;
		stageFiles(files);
	}

	function removeAttachment(id: string) {
		const attachment = pendingAttachments.find((entry) => entry.id === id);
		if (attachment?.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
		pendingAttachments = pendingAttachments.filter((entry) => entry.id !== id);
	}

	function clearAttachments() {
		for (const attachment of pendingAttachments) {
			if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
		}
		pendingAttachments = [];
	}

	function resizeTextarea() {
		if (!textareaRef) return;
		textareaRef.style.height = 'auto';
		textareaRef.style.height = `${Math.min(textareaRef.scrollHeight, expanded ? 320 : 128)}px`;
		textareaRef.style.overflowY =
			textareaRef.scrollHeight > (expanded ? 320 : 128) ? 'auto' : 'hidden';
	}

	// Track the last-seen focusKey so the effect skips its initial mount run. On mobile, focusing
	// the textarea the moment a chat opens pops the soft keyboard unbidden — only focus on an
	// explicit reply/edit, which bumps focusKey from its initial value.
	let lastFocusKey = untrack(() => focusKey);
	$effect(() => {
		void focusKey;
		if (!textareaRef || disabled) return;
		if (focusKey === lastFocusKey) return;
		lastFocusKey = focusKey;
		textareaRef.focus();
		const length = textareaRef.value.length;
		textareaRef.setSelectionRange(length, length);
		resizeTextarea();
	});

	$effect(() => {
		void value;
		if (!textareaRef) return;
		requestAnimationFrame(() => resizeTextarea());
	});

	$effect(() => {
		if (!replyTo) return;
		const sub = addressLoader({
			kind: Metadata,
			pubkey: replyTo.author,
			relays: metadataRelays
		}).subscribe();

		return () => sub.unsubscribe();
	});

	$effect(() => {
		void expanded;
		resizeTextarea();
	});
</script>

<div class="border-t border-border bg-background">
	<form class="mx-auto max-w-5xl px-3 pt-3 pb-safe sm:px-4 md:px-6" onsubmit={handleSubmit}>
		{#if editTo}
			<div
				class="mb-3 flex items-start justify-between gap-3 rounded-xl border border-border bg-card px-3 py-2"
			>
				<div class="min-w-0">
					<div class="mb-1 flex items-center gap-2 text-xs font-medium text-muted-foreground">
						<Pencil class="size-3.5" />
						<span>Editing message</span>
					</div>
					<p class={`${COMPOSER_PREVIEW_WRAP_CLASS} text-foreground/80`}>
						{editTo.text}
					</p>
				</div>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					class="h-8 w-8 shrink-0 rounded-lg"
					onclick={onCancelEdit}
					aria-label="Cancel edit"
				>
					<X class="size-4" />
				</Button>
			</div>
		{/if}

		{#if replyTo}
			<div
				class="mb-3 flex items-start justify-between gap-3 rounded-xl border border-border bg-card px-3 py-2"
			>
				<div class="min-w-0">
					<div class="mb-1 flex items-center gap-2 text-xs font-medium text-muted-foreground">
						<Reply class="size-3.5" />
						<span>Replying to</span>
						<ProfileCard
							pubkey={replyTo.author}
							mode="inline"
							showInlineAvatar={true}
							profileLink={false}
						/>
					</div>
					<p class={`${COMPOSER_PREVIEW_WRAP_CLASS} text-foreground/80`}>
						{replyTo.text}
					</p>
				</div>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					class="h-8 w-8 shrink-0 rounded-lg"
					onclick={onCancelReply}
					aria-label="Cancel reply"
				>
					<X class="size-4" />
				</Button>
			</div>
		{/if}

		<input
			bind:this={documentInputRef}
			type="file"
			multiple
			class="hidden"
			onchange={handleFileSelected}
		/>

		{#if pendingAttachments.length > 0}
			<div class="mb-3 flex flex-wrap gap-2">
				{#each pendingAttachments as attachment (attachment.id)}
					<div
						class="flex max-w-[16rem] items-center gap-2 rounded-xl border border-border bg-card py-1.5 pr-1 pl-1.5"
					>
						{#if attachment.previewUrl}
							<img
								src={attachment.previewUrl}
								alt={attachment.file.name}
								class="size-10 shrink-0 rounded-lg object-cover"
							/>
						{:else}
							<div class="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
								<Paperclip class="size-4 text-muted-foreground" />
							</div>
						{/if}
						<div class="min-w-0 flex-1">
							<p class="truncate text-xs font-medium">{attachment.file.name}</p>
							<p class="text-[11px] text-muted-foreground">
								{formatBytes(attachment.file.size)}
							</p>
						</div>
						<Button
							type="button"
							variant="ghost"
							size="icon"
							class="h-7 w-7 shrink-0 rounded-lg"
							onclick={() => removeAttachment(attachment.id)}
							aria-label="Remove attachment"
						>
							<X class="size-4" />
						</Button>
					</div>
				{/each}
			</div>
		{/if}

		<div class="flex min-w-0 items-end gap-3">
			{#if isRecording}
				{#if recorder.state === 'requesting' && requestingVisible}
					<div
						class="flex h-11 min-w-0 flex-1 items-center gap-3 rounded-xl border border-border bg-card px-3"
					>
						<span class="min-w-0 flex-1 animate-pulse truncate text-xs text-muted-foreground"
							>Waiting for microphone…</span
						>
						<button
							type="button"
							class="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-destructive"
							onclick={cancelRecording}
							aria-label="Cancel"
							title="Cancel"
						>
							<X class="size-4" />
						</button>
					</div>
				{:else if recorder.state === 'locked'}
					<div
						class="flex h-11 min-w-0 flex-1 items-center gap-3 rounded-xl border border-border bg-card px-3"
					>
						<button
							type="button"
							class="flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-destructive"
							onclick={cancelRecording}
							aria-label="Discard voice note"
							title="Discard"
						>
							<Trash class="size-4" />
						</button>
						<div class="flex h-6 min-w-0 flex-1 items-center gap-[2px]">
							{#each recorder.livePeaks as peak, i (i)}
								<div
									class="min-w-[2px] flex-1 rounded-full bg-foreground/50"
									style={`height: ${Math.max(10, Math.round(peak * 100))}%`}
								></div>
							{/each}
						</div>
						<span class="shrink-0 text-xs text-muted-foreground tabular-nums">
							{formatClock(recorder.elapsedMs / 1000)}
						</span>
						<button
							type="button"
							class="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-transform active:scale-95"
							onclick={finishLockedRecording}
							aria-label="Send voice note"
							title="Send"
						>
							<SendHorizontal class="size-4" />
						</button>
					</div>
				{:else}
					<!-- Active hold: drag up to lock, left to cancel. The lock target floats
					     above the record button, the cancel target sits at the left. Both
					     brighten + grow as the finger approaches; the record-button icon
					     crossfades mic → lock / mic → trash to reinforce the direction. -->
					<div class="relative flex w-full items-center gap-2">
						<div
							class="pointer-events-none absolute right-0 bottom-full z-20 mb-2 flex flex-col items-center gap-0.5 transition-all duration-150"
							style={`opacity: ${0.3 + 0.7 * lockProgress}; transform: scale(${0.8 + 0.2 * lockProgress})`}
						>
							<div
								class="flex size-10 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-md"
							>
								<Lock class="size-5" />
							</div>
							<ChevronUp class="size-3 text-muted-foreground" />
						</div>
						<div
							class="pointer-events-none flex shrink-0 items-center gap-0.5 transition-all duration-150"
							style={`opacity: ${0.3 + 0.7 * cancelProgress}; transform: scale(${0.8 + 0.2 * cancelProgress})`}
						>
							<ChevronLeft class="size-3 text-muted-foreground" />
							<div
								class="flex size-10 items-center justify-center rounded-full bg-destructive/15 text-destructive"
							>
								<Trash class="size-5" />
							</div>
						</div>
						<div class="flex h-7 min-w-0 flex-1 items-center gap-[2px] px-1">
							{#each recorder.livePeaks as peak, i (i)}
								<div
									class="min-w-[2px] flex-1 rounded-full bg-foreground/50"
									style={`height: ${Math.max(10, Math.round(peak * 100))}%`}
								></div>
							{/each}
						</div>
						<span class="shrink-0 text-xs text-muted-foreground tabular-nums">
							{formatClock(recorder.elapsedMs / 1000)}
						</span>
						<div
							class="text-destructive-foreground relative flex size-11 shrink-0 items-center justify-center rounded-full bg-destructive shadow-md"
						>
							<Mic
								class="absolute size-5 transition-opacity duration-100"
								style={`opacity: ${Math.max(0, 1 - lockProgress - cancelProgress)}`}
							/>
							<Lock
								class="absolute size-5 transition-opacity duration-100"
								style={`opacity: ${lockProgress}`}
							/>
							<Trash
								class="absolute size-5 transition-opacity duration-100"
								style={`opacity: ${cancelProgress}`}
							/>
						</div>
					</div>
				{/if}
			{:else}
				<ChatComposerActions
					onTakePhoto={takePhoto}
					onTakeVideo={takeVideo}
					onPickImage={pickImage}
					onPickDocument={pickDocument}
				/>
				<div class="flex min-w-0 flex-1 flex-col gap-2">
					{#if unreadReferenceCount > 0}
						<div class="flex justify-center">
							<Button
								type="button"
								variant="secondary"
								size="sm"
								class="h-8 gap-2 rounded-full shadow-lg"
								onclick={onNavigateToReference}
								aria-label="Jump to unread reference"
							>
								<AtSign class="size-4" />
								<span>{unreadReferenceCount}</span>
							</Button>
						</div>
					{/if}
					{#if activeMention && mentionMatches.length > 0}
						<div class="rounded-xl border border-border bg-popover p-1 shadow-lg">
							{#each mentionMatches as candidate, index (candidate.pubkey)}
								<button
									type="button"
									class={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm ${index === highlightedMentionIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60'}`}
									onclick={() => selectMention(candidate)}
								>
									<div class="min-w-0 flex-1">
										<ProfileCard pubkey={candidate.pubkey} mode="compact" profileLink={false} />
										<p class="mt-1 truncate text-xs text-muted-foreground">
											{getMentionHint(candidate)}
										</p>
									</div>
								</button>
							{/each}
						</div>
					{/if}
					<div class="flex justify-center">
						<Button
							type="button"
							variant="ghost"
							size="icon"
							class="h-8 w-8 rounded-lg"
							onclick={() => (expanded = !expanded)}
							aria-label={expanded ? 'Collapse composer' : 'Expand composer'}
						>
							<ChevronUp class={`size-4 transition-transform ${!expanded ? '' : 'rotate-180'}`} />
						</Button>
					</div>
					<Textarea
						bind:ref={textareaRef}
						bind:value
						placeholder="Type a message..."
						rows={expanded ? 6 : 1}
						wrap="soft"
						{disabled}
						onkeydown={handleKeyDown}
						oninput={handleInput}
						class={COMPOSER_INPUT_WRAP_CLASS}
						style={`max-height: ${expanded ? 320 : 128}px; min-height: ${expanded ? 144 : 44}px;`}
					/>
				</div>
				{#if showMic}
					<button
						type="button"
						class="flex size-11 shrink-0 touch-none items-center justify-center rounded-xl bg-primary text-primary-foreground transition-transform active:scale-95"
						onpointerdown={startVoice}
						aria-label="Hold to record voice note"
						title="Hold to record voice note"
					>
						<Mic class="size-5" />
					</button>
				{:else}
					<Button
						type="submit"
						class="h-11 shrink-0 rounded-xl px-4"
						disabled={disabled || (!value.trim() && pendingAttachments.length === 0)}
					>
						<SendHorizontal class="size-4" />
					</Button>
				{/if}
			{/if}
		</div>
	</form>
</div>
