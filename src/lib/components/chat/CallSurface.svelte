<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import Avatar from '$lib/components/Avatar.svelte';
	import ProfileCard from '$lib/components/ProfileCard.svelte';
	import { manager } from '$lib/services/accountManager.svelte';
	import { getChatGroup, listChatGroupMembers } from '$lib/services/chatGroups.svelte';
	import { getChatGroupDisplayTitle } from '$lib/components/chat/chatGroupDisplay';
	import { formatCallDuration, normalizePubKey } from '$lib/utils';
	import { onDestroy, onMount, tick } from 'svelte';
	import {
		attachChatCallVideo,
		chatCallMemberPubkey,
		chatCallsStore,
		closeChatCallSurface,
		confirmChatCall,
		detachChatCallVideo,
		leaveChatCall,
		setChatCallCameraEnabled,
		setChatCallMicrophoneEnabled,
		setChatCallScreenShareEnabled,
		toggleChatCallPinned
	} from '$lib/services/chatCalls.svelte';
	import type { CallVideoSource } from '$lib/services/liveKitCallEngine';
	import Phone from '@lucide/svelte/icons/phone';
	import PhoneOff from '@lucide/svelte/icons/phone-off';
	import Mic from '@lucide/svelte/icons/mic';
	import MicOff from '@lucide/svelte/icons/mic-off';
	import Video from '@lucide/svelte/icons/video';
	import VideoOff from '@lucide/svelte/icons/video-off';
	import Minimize2 from '@lucide/svelte/icons/minimize-2';
	import Maximize from '@lucide/svelte/icons/maximize';
	import Minimize from '@lucide/svelte/icons/minimize';
	import Expand from '@lucide/svelte/icons/expand';
	import Pin from '@lucide/svelte/icons/pin';
	import PinOff from '@lucide/svelte/icons/pin-off';
	import ScreenShare from '@lucide/svelte/icons/screen-share';
	import ScreenShareOff from '@lucide/svelte/icons/screen-share-off';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import LockKeyhole from '@lucide/svelte/icons/lock-keyhole';
	import Users from '@lucide/svelte/icons/users';

	// This surface is mounted by the chat layout, so unmounting it means the reader left
	// /chat: the microphone and camera must not keep running with no control on screen.
	onDestroy(() => void leaveChatCall());

	let fullscreenEl = $state<HTMLElement | null>(null);
	let mainEl = $state<HTMLElement | null>(null);
	let isFullscreen = $state(false);
	let isMainFullscreen = $state(false);
	let fullscreenSupported = $state(false);
	let screenShareSupported = $state(false);
	let now = $state(Date.now());

	$effect(() => {
		if (chatCallsStore.connectedAt === null) return;
		now = Date.now();
		const timer = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(timer);
	});

	onMount(() => {
		fullscreenSupported = document.fullscreenEnabled;
		screenShareSupported = typeof navigator.mediaDevices?.getDisplayMedia === 'function';
		const onFullscreenChange = () => {
			isFullscreen = Boolean(fullscreenEl && document.fullscreenElement === fullscreenEl);
			isMainFullscreen = Boolean(mainEl && document.fullscreenElement === mainEl);
		};
		document.addEventListener('fullscreenchange', onFullscreenChange);
		return () => {
			document.removeEventListener('fullscreenchange', onFullscreenChange);
			// Leaving /chat must not leave the browser in fullscreen behind the next page.
			if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
		};
	});

	async function toggleFullscreen() {
		try {
			if (document.fullscreenElement) await document.exitFullscreen();
			else await fullscreenEl?.requestFullscreen();
		} catch {
			// Refused (permissions policy, another fullscreen element): stay windowed.
		}
	}

	async function minimizeCall() {
		if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
		closeChatCallSurface();
	}

	async function toggleMainFullscreen() {
		try {
			if (document.fullscreenElement === mainEl) await document.exitFullscreen();
			else await mainEl?.requestFullscreen();
		} catch {
			// Refused: stay in the dialog.
		}
	}

	/** Pin, then fullscreen the main view — one click from a participant card. */
	async function fullscreenParticipant(identity: string) {
		chatCallsStore.pinnedIdentity = identity;
		await tick();
		await mainEl?.requestFullscreen().catch(() => {});
	}

	const activeGroupId = $derived(chatCallsStore.active?.groupId ?? chatCallsStore.lobby?.groupId);
	const activeGroup = $derived.by(() => (activeGroupId ? getChatGroup(activeGroupId) : undefined));
	// Same title the chat header shows: an unnamed group is known by its members.
	const groupTitle = $derived.by(() => {
		if (!activeGroup || !activeGroupId) return 'Group call';
		const pubkey = manager.getActive()?.pubkey;
		return getChatGroupDisplayTitle({
			group: activeGroup,
			activePubkey: pubkey ? normalizePubKey(pubkey) : '',
			memberPubkeys: listChatGroupMembers(activeGroupId).map((member) =>
				normalizePubKey(member.stablePubkey)
			)
		});
	});
	const serviceHost = $derived.by(() => {
		const service = chatCallsStore.active?.service ?? chatCallsStore.lobby?.service;
		if (!service) return '';
		try {
			return new URL(service).host;
		} catch {
			return service;
		}
	});
	const phaseLabel = $derived.by(() => {
		if (chatCallsStore.phase === 'reconnecting') return 'Reconnecting…';
		if (chatCallsStore.phase === 'connecting' || chatCallsStore.busy) return 'Connecting…';
		return 'End-to-end encrypted';
	});
	const callDuration = $derived(
		formatCallDuration(
			chatCallsStore.connectedAt === null
				? 0
				: Math.max(0, (now - chatCallsStore.connectedAt) / 1000)
		)
	);

	// One main view: the pinned participant, else whoever shares last. The pinned card
	// leaves the grid so its track is only ever attached to one element.
	const pinnedParticipant = $derived(
		chatCallsStore.participants.find((p) => p.identity === chatCallsStore.pinnedIdentity) ?? null
	);
	const sharedParticipant = $derived(
		chatCallsStore.participants.findLast((p) => p.screenSharing) ?? null
	);
	const mainParticipant = $derived(pinnedParticipant ?? sharedParticipant);
	const mainSource: CallVideoSource = $derived(
		mainParticipant?.screenSharing ? 'screen' : 'camera'
	);
	const gridParticipants = $derived(
		pinnedParticipant
			? chatCallsStore.participants.filter((p) => p.identity !== pinnedParticipant.identity)
			: chatCallsStore.participants
	);

	function participantPubkey(identity: string, isLocal: boolean): string | null {
		return isLocal
			? (manager.getActive()?.pubkey ?? chatCallMemberPubkey(identity))
			: chatCallMemberPubkey(identity);
	}

	function videoAttachment(
		element: HTMLVideoElement,
		initial: { identity: string; source: CallVideoSource }
	) {
		let current = initial;
		attachChatCallVideo(current.identity, element, current.source);
		return {
			update(next: { identity: string; source: CallVideoSource }) {
				if (next.identity === current.identity && next.source === current.source) return;
				detachChatCallVideo(element);
				current = next;
				attachChatCallVideo(current.identity, element, current.source);
			},
			destroy() {
				detachChatCallVideo(element);
			}
		};
	}
</script>

<Dialog.Root bind:open={chatCallsStore.dialogOpen}>
	<Dialog.Content
		showCloseButton={false}
		class="flex h-dvh max-h-dvh flex-col gap-0 overflow-hidden rounded-none p-0 sm:h-[calc(100dvh-2rem)] sm:max-w-5xl sm:rounded-4xl"
	>
		<!-- The fullscreen target is this inner wrapper, not the dialog box: the dialog's own
		     centering/size classes would otherwise fight the browser's fullscreen sizing.
		     pt-inset: portaled dialogs miss the chat layout's pt-safe, so without it the header
		     sits under the Android status bar (0px on web, so desktop is unchanged). -->
		<div bind:this={fullscreenEl} class="flex h-full min-h-0 flex-col bg-popover pt-inset">
			<Dialog.Header class="flex-row items-center gap-3 border-b px-4 py-3 text-left sm:px-6">
				<div class="min-w-0 flex-1">
					<Dialog.Title class="truncate">{groupTitle}</Dialog.Title>
					<Dialog.Description class="mt-0.5 flex items-center gap-1.5 text-xs">
						<LockKeyhole class="size-3.5" />
						<span>{phaseLabel}</span>
						{#if chatCallsStore.connectedAt !== null}
							<span class="shrink-0 tabular-nums" aria-label="Call duration">
								· {callDuration}
							</span>
						{/if}
					</Dialog.Description>
				</div>
				{#if fullscreenSupported && chatCallsStore.active}
					<Button
						variant="ghost"
						size="icon"
						aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
						onclick={() => void toggleFullscreen()}
					>
						{#if isFullscreen}<Minimize />{:else}<Maximize />{/if}
					</Button>
				{/if}
				<Button
					variant="ghost"
					size="icon"
					onclick={() => void minimizeCall()}
					aria-label="Minimize call"
				>
					<Minimize2 />
				</Button>
			</Dialog.Header>

			{#if chatCallsStore.error}
				<p
					class="border-b bg-destructive/10 px-4 py-2 text-sm text-destructive sm:px-6"
					role="alert"
				>
					{chatCallsStore.error}
				</p>
			{/if}

			{#if chatCallsStore.active}
				<div class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-4 sm:p-6">
					{#if chatCallsStore.participants.length === 0}
						<div class="flex h-full min-h-48 items-center justify-center text-muted-foreground">
							<LoaderCircle class="mr-2 size-5 animate-spin" /> Joining the room…
						</div>
					{:else}
						{#if mainParticipant}
							{@const mainPubkey = participantPubkey(
								mainParticipant.identity,
								mainParticipant.isLocal
							)}
							<div
								bind:this={mainEl}
								class="main-call-view mb-3 overflow-hidden rounded-2xl border bg-black"
							>
								<div
									class="flex shrink-0 items-center gap-2 border-b border-white/10 bg-background px-3 py-2 text-sm"
								>
									{#if mainPubkey}
										<div class="min-w-0 flex-1 truncate font-medium">
											<ProfileCard pubkey={mainPubkey} mode="inline" profileLink={false} />
										</div>
									{:else}
										<span class="min-w-0 flex-1 truncate font-medium text-amber-600"
											>Unknown participant</span
										>
									{/if}
									<span class="shrink-0 text-xs text-muted-foreground">
										{mainSource === 'screen'
											? 'screen'
											: mainParticipant.cameraEnabled
												? 'camera'
												: 'audio'}
										{#if chatCallsStore.connectedAt !== null}
											<span class="tabular-nums"> · {callDuration}</span>
										{/if}
									</span>
									<div class="ml-auto flex shrink-0 items-center gap-1">
										{#if pinnedParticipant}
											<Button
												variant="ghost"
												size="icon-sm"
												aria-label="Unpin participant"
												onclick={() => toggleChatCallPinned(pinnedParticipant.identity)}
											>
												<PinOff />
											</Button>
										{/if}
										{#if fullscreenSupported}
											<Button
												variant="ghost"
												size="icon-sm"
												aria-label={isMainFullscreen ? 'Exit full screen' : 'View full screen'}
												onclick={() => void toggleMainFullscreen()}
											>
												{#if isMainFullscreen}<Minimize />{:else}<Maximize />{/if}
											</Button>
										{/if}
									</div>
								</div>
								{#if mainSource === 'screen' || mainParticipant.cameraEnabled}
									{#key `${mainParticipant.identity}:${mainSource}:${mainParticipant.cameraEnabled}`}
										<video
											use:videoAttachment={{
												identity: mainParticipant.identity,
												source: mainSource
											}}
											class="main-call-video mx-auto max-h-[60dvh] w-full object-contain"
											class:main-call-camera={mainSource === 'camera'}
											class:-scale-x-100={mainSource === 'camera' && mainParticipant.isLocal}
											autoplay
											playsinline
											muted={mainParticipant.isLocal}
											aria-label={mainSource === 'screen' ? 'Shared screen' : 'Participant video'}
										></video>
									{/key}
								{:else}
									<div class="main-call-avatar flex min-h-40 items-center justify-center">
										{#if mainPubkey}
											<Avatar pubkey={mainPubkey} size="size-24" />
										{:else}
											<Users class="size-16 text-muted-foreground" />
										{/if}
									</div>
								{/if}
							</div>
						{/if}
						<div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
							{#each gridParticipants as participant (participant.identity)}
								{@const pubkey = participantPubkey(participant.identity, participant.isLocal)}
								<div
									class="relative flex aspect-video min-h-40 w-full items-center justify-center overflow-hidden rounded-2xl border bg-muted/40"
									class:border-primary={participant.isSpeaking}
									class:ring-2={participant.isSpeaking}
									class:ring-primary={participant.isSpeaking}
								>
									{#if participant.cameraEnabled}
										{#key `${participant.identity}:${participant.cameraEnabled}`}
											<video
												use:videoAttachment={{ identity: participant.identity, source: 'camera' }}
												class="h-full w-full object-cover"
												class:-scale-x-100={participant.isLocal}
												autoplay
												playsinline
												muted={participant.isLocal}
												aria-label={pubkey ? 'Participant video' : 'Unknown participant video'}
											></video>
										{/key}
									{:else if pubkey}
										<Avatar {pubkey} size="size-20" />
									{:else}
										<Users class="size-16 text-muted-foreground" />
									{/if}
									<div class="absolute top-2 right-2 flex gap-1">
										<Button
											variant="secondary"
											size="icon-sm"
											aria-label="Pin participant"
											onclick={() => toggleChatCallPinned(participant.identity)}
										>
											<Pin class="size-4" />
										</Button>
										{#if fullscreenSupported && (participant.cameraEnabled || participant.screenSharing)}
											<Button
												variant="secondary"
												size="icon-sm"
												aria-label="View participant full screen"
												onclick={() => void fullscreenParticipant(participant.identity)}
											>
												<Expand class="size-4" />
											</Button>
										{/if}
									</div>
									<div
										class="absolute inset-x-2 bottom-2 flex items-center gap-2 rounded-xl bg-background/90 px-2.5 py-2 shadow-sm backdrop-blur"
									>
										{#if pubkey}
											<div class="min-w-0 flex-1 truncate text-sm font-medium">
												<ProfileCard {pubkey} mode="inline" profileLink={false} />
											</div>
										{:else}
											<span class="min-w-0 flex-1 truncate text-sm font-medium text-amber-600"
												>Unknown participant</span
											>
										{/if}
										{#if !participant.microphoneEnabled}
											<MicOff class="size-4 shrink-0 text-muted-foreground" aria-label="Muted" />
										{/if}
									</div>
								</div>
							{/each}
						</div>
					{/if}
				</div>
			{:else}
				<div class="flex flex-1 flex-col items-center justify-center gap-6 p-6 text-center">
					<div class="rounded-full bg-primary/10 p-5 text-primary"><Phone class="size-9" /></div>
					<div>
						<h2 class="text-xl font-semibold">
							{chatCallsStore.lobby?.callId ? 'Join the call' : 'Start a call'}
						</h2>
						<p class="mt-2 max-w-md text-sm text-muted-foreground">
							Audio and video are encrypted with this group's MLS keys. The token service is
							<span class="font-medium text-foreground">{serviceHost}</span>.
						</p>
					</div>
					<div class="flex gap-3">
						<Button
							variant="outline"
							class="h-12 px-4"
							aria-pressed={chatCallsStore.microphoneEnabled}
							onclick={() => void setChatCallMicrophoneEnabled(!chatCallsStore.microphoneEnabled)}
						>
							{#if chatCallsStore.microphoneEnabled}<Mic /> Microphone on{:else}<MicOff /> Microphone
								off{/if}
						</Button>
						<Button
							variant="outline"
							class="h-12 px-4"
							aria-pressed={chatCallsStore.cameraEnabled}
							onclick={() => void setChatCallCameraEnabled(!chatCallsStore.cameraEnabled)}
						>
							{#if chatCallsStore.cameraEnabled}<Video /> Camera on{:else}<VideoOff /> Camera off{/if}
						</Button>
					</div>
				</div>
			{/if}

			<div
				class="flex flex-wrap items-center justify-center gap-3 border-t bg-background p-4 pb-safe sm:p-5"
			>
				{#if chatCallsStore.active}
					<Button
						variant={chatCallsStore.microphoneEnabled ? 'secondary' : 'outline'}
						class="h-12 min-w-28"
						disabled={!chatCallsStore.participants.length}
						onclick={() => void setChatCallMicrophoneEnabled(!chatCallsStore.microphoneEnabled)}
					>
						{#if chatCallsStore.microphoneEnabled}<Mic /> Mute{:else}<MicOff /> Unmute{/if}
					</Button>
					<Button
						variant={chatCallsStore.cameraEnabled ? 'secondary' : 'outline'}
						class="h-12 min-w-28"
						disabled={!chatCallsStore.participants.length}
						onclick={() => void setChatCallCameraEnabled(!chatCallsStore.cameraEnabled)}
					>
						{#if chatCallsStore.cameraEnabled}<Video /> Camera off{:else}<VideoOff /> Camera on{/if}
					</Button>
					{#if screenShareSupported}
						<Button
							variant={chatCallsStore.screenShareEnabled ? 'secondary' : 'outline'}
							class="h-12 min-w-28"
							disabled={!chatCallsStore.participants.length}
							onclick={() => void setChatCallScreenShareEnabled(!chatCallsStore.screenShareEnabled)}
						>
							{#if chatCallsStore.screenShareEnabled}<ScreenShareOff /> Stop share{:else}<ScreenShare
								/>
								Share screen{/if}
						</Button>
					{/if}
					<Button variant="destructive" class="h-12 min-w-28" onclick={() => void leaveChatCall()}>
						<PhoneOff /> Leave
					</Button>
				{:else}
					<Button variant="outline" class="h-12" onclick={closeChatCallSurface}>Cancel</Button>
					<Button
						class="h-12 min-w-32"
						disabled={chatCallsStore.busy}
						onclick={() => void confirmChatCall()}
					>
						{#if chatCallsStore.busy}<LoaderCircle class="animate-spin" /> Connecting…{:else}<Phone
							/>
							{chatCallsStore.lobby?.callId ? 'Join call' : 'Start call'}{/if}
					</Button>
				{/if}
			</div>
		</div>
	</Dialog.Content>
</Dialog.Root>

{#if chatCallsStore.active && !chatCallsStore.dialogOpen}
	<div
		class="fixed bottom-20 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-2xl border bg-background p-2 shadow-xl"
	>
		<Button variant="secondary" class="max-w-56" onclick={() => (chatCallsStore.dialogOpen = true)}>
			<Phone /> <span class="min-w-0 truncate">{groupTitle}</span>
			{#if chatCallsStore.connectedAt !== null}
				<span class="shrink-0 text-xs tabular-nums">{callDuration}</span>
			{/if}
		</Button>
		<Button
			variant="ghost"
			size="icon-lg"
			aria-label={chatCallsStore.microphoneEnabled ? 'Mute' : 'Unmute'}
			onclick={() => void setChatCallMicrophoneEnabled(!chatCallsStore.microphoneEnabled)}
		>
			{#if chatCallsStore.microphoneEnabled}<Mic />{:else}<MicOff />{/if}
		</Button>
		<Button
			variant="destructive"
			size="icon-lg"
			aria-label="Leave call"
			onclick={() => void leaveChatCall()}
		>
			<PhoneOff />
		</Button>
	</div>
{/if}

<style>
	/* Nested fullscreen gets its own safe areas: the dialog wrapper is no longer painted. */
	.main-call-view:fullscreen {
		display: flex;
		flex-direction: column;
		width: 100vw;
		height: 100dvh;
		margin: 0;
		border: 0;
		border-radius: 0;
		padding-top: var(--safe-area-inset-top, env(safe-area-inset-top, 0px));
		padding-right: var(--safe-area-inset-right, env(safe-area-inset-right, 0px));
		padding-bottom: var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px));
		padding-left: var(--safe-area-inset-left, env(safe-area-inset-left, 0px));
	}
	.main-call-view:fullscreen .main-call-video {
		flex: 1;
		min-height: 0;
		height: 100%;
		max-height: none;
	}
	.main-call-view:fullscreen .main-call-camera {
		object-fit: cover;
	}
	.main-call-view:fullscreen .main-call-avatar {
		flex: 1;
		min-height: 0;
	}
</style>
