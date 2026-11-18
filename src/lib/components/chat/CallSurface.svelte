<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import Avatar from '$lib/components/Avatar.svelte';
	import ProfileCard from '$lib/components/ProfileCard.svelte';
	import { manager } from '$lib/services/accountManager.svelte';
	import { getChatGroup, listChatGroupMembers } from '$lib/services/chatGroups.svelte';
	import { getChatGroupDisplayTitle } from '$lib/components/chat/chatGroupDisplay';
	import { normalizePubKey } from '$lib/utils';
	import { onDestroy } from 'svelte';
	import {
		attachChatCallVideo,
		chatCallMemberPubkey,
		chatCallsStore,
		closeChatCallSurface,
		confirmChatCall,
		detachChatCallVideo,
		leaveChatCall,
		setChatCallCameraEnabled,
		setChatCallMicrophoneEnabled
	} from '$lib/services/chatCalls.svelte';
	import Phone from '@lucide/svelte/icons/phone';
	import PhoneOff from '@lucide/svelte/icons/phone-off';
	import Mic from '@lucide/svelte/icons/mic';
	import MicOff from '@lucide/svelte/icons/mic-off';
	import Video from '@lucide/svelte/icons/video';
	import VideoOff from '@lucide/svelte/icons/video-off';
	import Minimize2 from '@lucide/svelte/icons/minimize-2';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import LockKeyhole from '@lucide/svelte/icons/lock-keyhole';
	import Users from '@lucide/svelte/icons/users';

	// This surface is mounted by the chat layout, so unmounting it means the reader left
	// /chat: the microphone and camera must not keep running with no control on screen.
	onDestroy(() => void leaveChatCall());

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

	function participantPubkey(identity: string, isLocal: boolean): string | null {
		return isLocal
			? (manager.getActive()?.pubkey ?? chatCallMemberPubkey(identity))
			: chatCallMemberPubkey(identity);
	}

	function videoAttachment(element: HTMLVideoElement, identity: string) {
		attachChatCallVideo(identity, element);
		return {
			update(nextIdentity: string) {
				detachChatCallVideo(element);
				attachChatCallVideo(nextIdentity, element);
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
		<Dialog.Header class="flex-row items-center gap-3 border-b px-4 py-3 text-left sm:px-6">
			<div class="min-w-0 flex-1">
				<Dialog.Title class="truncate">{groupTitle}</Dialog.Title>
				<Dialog.Description class="mt-0.5 flex items-center gap-1.5 text-xs">
					<LockKeyhole class="size-3.5" />
					<span>{phaseLabel}</span>
				</Dialog.Description>
			</div>
			<Button variant="ghost" size="icon" onclick={closeChatCallSurface} aria-label="Minimize call">
				<Minimize2 />
			</Button>
		</Dialog.Header>

		{#if chatCallsStore.error}
			<p class="border-b bg-destructive/10 px-4 py-2 text-sm text-destructive sm:px-6" role="alert">
				{chatCallsStore.error}
			</p>
		{/if}

		{#if chatCallsStore.active}
			<div class="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
				{#if chatCallsStore.participants.length === 0}
					<div class="flex h-full min-h-48 items-center justify-center text-muted-foreground">
						<LoaderCircle class="mr-2 size-5 animate-spin" /> Joining the room…
					</div>
				{:else}
					<div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
						{#each chatCallsStore.participants as participant (participant.identity)}
							{@const pubkey = participantPubkey(participant.identity, participant.isLocal)}
							<div
								class="relative flex aspect-video min-h-40 items-center justify-center overflow-hidden rounded-2xl border bg-muted/40"
								class:border-primary={participant.isSpeaking}
								class:ring-2={participant.isSpeaking}
								class:ring-primary={participant.isSpeaking}
							>
								{#if participant.cameraEnabled}
									{#key `${participant.identity}:${participant.cameraEnabled}`}
										<video
											use:videoAttachment={participant.identity}
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
						{#if chatCallsStore.microphoneEnabled}<Mic /> Microphone on{:else}<MicOff /> Microphone off{/if}
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
					{#if chatCallsStore.busy}<LoaderCircle class="animate-spin" /> Connecting…{:else}<Phone />
						{chatCallsStore.lobby?.callId ? 'Join call' : 'Start call'}{/if}
				</Button>
			{/if}
		</div>
	</Dialog.Content>
</Dialog.Root>

{#if chatCallsStore.active && !chatCallsStore.dialogOpen}
	<div
		class="fixed bottom-20 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-2xl border bg-background p-2 shadow-xl"
	>
		<Button variant="secondary" class="max-w-48" onclick={() => (chatCallsStore.dialogOpen = true)}>
			<Phone /> <span class="truncate">{groupTitle}</span>
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
