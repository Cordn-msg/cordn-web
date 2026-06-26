<script lang="ts">
	import { untrack } from 'svelte';
	import { page } from '$app/state';
	import AccountLoginDialog from '$lib/components/AccountLoginDialog.svelte';
	import ChatShell from '$lib/components/chat/ChatShell.svelte';
	import WelcomeNotificationCard from '$lib/components/chat/WelcomeNotificationCard.svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Spinner } from '$lib/components/ui/spinner';
	import { DEFAULT_CHAT_COORDINATOR_PUBKEY } from '$lib/constants/chat';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import {
		getCoordinatorLabel,
		markCoordinatorUsed,
		upsertChatCoordinator
	} from '$lib/services/chatCoordinators.svelte';
	import { getChatGroup } from '$lib/services/chatGroups.svelte';
	import {
		createChatKeyPackage,
		listChatKeyPackages,
		publishChatKeyPackage
	} from '$lib/services/chatKeyPackages.svelte';
	import {
		hasJoinRequestBeenSent,
		markJoinRequestSent,
		removeSentJoinRequest,
		storeJoinRequest
	} from '$lib/services/chatJoinRequests.svelte';
	import {
		isWelcomeSubmitting,
		listWelcomeNotifications
	} from '$lib/services/chatWelcomeNotifications.svelte';
	import { metadataRelays } from '$lib/services/relay-pool';
	import {
		acceptWelcomeAction,
		rejectWelcomeAction,
		refreshCoordinatorWelcomeNotificationsAction
	} from '$lib/services/chatUiActions.svelte';
	import { useProfileHints } from '$lib/services/useProfileHints.svelte';
	import { normalizePubKey } from '$lib/utils';
	import { DIALOG_IDS, dialogState } from '$lib/stores/dialog-state.svelte';
	import {
		decodeCoordinatorQueryParam,
		decodeGroupMetadataQueryParam
	} from '$lib/utils/groupShareLink';
	import MessageCirclePlus from '@lucide/svelte/icons/message-circle-plus';
	import RotateCw from '@lucide/svelte/icons/rotate-cw';

	let { params } = $props();

	const group = $derived.by(() => getChatGroup(params.id));
	const groupId = $derived.by(() => params.id);
	// Coordinator is read from the `c=` query param. Default to the public
	// coordinator ONLY when no `c=` is present at all, so groups on the default
	// coordinator can keep short links. A present-but-malformed `c=` must NOT
	// silently default — that would route the join request to the wrong place.
	const coordinatorParam = $derived(page.url.searchParams.get('c')?.trim() ?? '');
	const coordinatorQuery = $derived(
		coordinatorParam ? decodeCoordinatorQueryParam(coordinatorParam) : null
	);
	const coordinatorKey = $derived(
		!coordinatorParam ? DEFAULT_CHAT_COORDINATOR_PUBKEY : (coordinatorQuery?.coordinatorKey ?? '')
	);
	const coordinatorError = $derived(
		coordinatorParam && !coordinatorQuery
			? 'This invite link has a malformed coordinator. Ask for a new link.'
			: ''
	);
	const shareMetadata = $derived.by(() => {
		const value = page.url.searchParams.get('m')?.trim();
		if (!value) return null;
		return decodeGroupMetadataQueryParam(value);
	});

	// Auto-register unknown coordinators from share links
	$effect(() => {
		if (!coordinatorQuery) return;
		untrack(() => {
			upsertChatCoordinator({
				pubkey: coordinatorQuery.coordinatorKey,
				relays: coordinatorQuery.relays
			});
			markCoordinatorUsed(coordinatorQuery.coordinatorKey);
		});
	});

	let requesting = $state(false);
	let requestError = $state('');
	let requestSent = $state(untrack(() => hasJoinRequestBeenSent(params.id)));
	let requestAfterLogin = $state(false);

	const relatedWelcomes = $derived.by(() => {
		const key = coordinatorKey;
		if (!key) return [];
		return listWelcomeNotifications().filter((w) => w.coordinatorKey === key);
	});

	const welcomeProfileHints = useProfileHints(
		() => {
			const activePubkey = $activeAccount ? normalizePubKey($activeAccount.pubkey) : '';
			return [
				...new Set(
					relatedWelcomes
						.flatMap((w) => w.preview?.memberPubkeys ?? [])
						.map((pk) => normalizePubKey(pk))
						.filter((pk) => pk && pk !== activePubkey)
				)
			];
		},
		{ relays: metadataRelays }
	);

	let refreshingWelcomes = $state(false);

	async function refreshWelcomes() {
		if (!$activeAccount || refreshingWelcomes) return;
		refreshingWelcomes = true;
		try {
			await refreshCoordinatorWelcomeNotificationsAction(coordinatorKey);
		} finally {
			refreshingWelcomes = false;
		}
	}

	async function acceptWelcome(id: string) {
		if (!$activeAccount) return;
		await acceptWelcomeAction(id);
	}

	async function rejectWelcome(id: string) {
		if (!$activeAccount) return;
		await rejectWelcomeAction(id);
	}

	$effect(() => {
		if (!requestAfterLogin || !$activeAccount || requesting) {
			return;
		}

		requestAfterLogin = false;
		void handleRequestJoin();
	});

	async function handleRequestJoin() {
		if (!$activeAccount) {
			requestAfterLogin = true;
			dialogState.dialogId = DIALOG_IDS.LOGIN;
			return;
		}

		if (requesting || requestSent) return;

		requesting = true;
		requestError = '';

		if (!coordinatorKey) {
			// ponytail: coordinatorError already gates the UI button; this guard
			// keeps handleRequestJoin safe if ever called with a malformed link.
			requestError = 'Cannot request to join: this link has no valid coordinator.';
			requesting = false;
			return;
		}

		try {
			// A key package ref is only consumable on the coordinator it was
			// published to: the ref is global but its existence is per-coordinator.
			// So reuse a last-resort already published to THIS coordinator, else
			// reuse + publish a last-resort held elsewhere, else mint a new
			// last-resort here. Last-resort is mandatory so a concurrent consume
			// by another group/admin can't strand the join before a welcome lands.
			const normalizedCoordinator = normalizePubKey(coordinatorKey);
			const existingKeyPackages = listChatKeyPackages($activeAccount.pubkey);
			const alreadyHere = existingKeyPackages.find(
				(kp) => kp.isLastResort && kp.publishedCoordinatorKeys.includes(normalizedCoordinator)
			);

			let keyPackageRef: string;
			if (alreadyHere) {
				keyPackageRef = alreadyHere.keyPackageRef;
			} else {
				const reusable = existingKeyPackages.find((kp) => kp.isLastResort);
				if (reusable) {
					await publishChatKeyPackage(reusable.keyPackageRef, normalizedCoordinator);
					keyPackageRef = reusable.keyPackageRef;
				} else {
					const created = await createChatKeyPackage({
						isLastResort: true,
						publishCoordinatorKey: normalizedCoordinator
					});
					keyPackageRef = created.record.keyPackageRef;
				}
			}

			await storeJoinRequest(coordinatorKey, groupId, keyPackageRef);
			markJoinRequestSent(groupId);
			requestSent = true;
			void refreshWelcomes();
		} catch (error) {
			requestError = error instanceof Error ? error.message : 'Failed to request to join group';
		} finally {
			requesting = false;
		}
	}

	// Manual escape hatch for stuck requests (welcome dismissed/expired,
	// admin never answered). Mirrors markJoinRequestSent's pair in reverse.
	function handleRequestAgain() {
		removeSentJoinRequest(groupId);
		requestSent = false;
	}
</script>

<svelte:head>
	<title>{group?.metadata?.name || shareMetadata?.name || 'Chat'} | Cordn</title>
	<meta name="description" content="Cordn group chat route." />
</svelte:head>

{#if group}
	<ChatShell groupId={group.id} title={group.metadata?.name || 'Chat'} />
{:else if groupId}
	<div class="hidden">
		<AccountLoginDialog />
	</div>

	<div class="flex h-full min-h-0 flex-col bg-background text-foreground">
		<div class="flex flex-1 items-center justify-center px-4 py-12">
			<Card.Root class="w-full max-w-md">
				<Card.Header>
					<Card.Title>
						{#if shareMetadata?.icon}
							<span class="mr-1.5">{shareMetadata.icon}</span>
						{/if}
						{shareMetadata?.name || 'Group'}
					</Card.Title>
					<Card.Description>You are not a member of this group yet.</Card.Description>
				</Card.Header>
				<Card.Content class="space-y-4">
					<div class="rounded-xl bg-muted/40 p-3 text-sm text-muted-foreground">
						<p class="font-mono text-xs break-all">{groupId}</p>
					</div>

					{#if coordinatorError}
						<div class="rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">
							{coordinatorError}
						</div>
					{/if}

					{#if relatedWelcomes.length > 0 && !requestSent}
						<div class="space-y-2">
							{#each relatedWelcomes as notification (notification.id)}
								<WelcomeNotificationCard
									{notification}
									profileHints={welcomeProfileHints}
									coordinatorLabel={getCoordinatorLabel(notification.coordinatorKey)}
									submitting={isWelcomeSubmitting(notification.id)}
									onAccept={() => acceptWelcome(notification.id)}
									onReject={() => rejectWelcome(notification.id)}
								/>
							{/each}
						</div>
					{/if}

					{#if requestSent}
						<div
							class="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
						>
							Join request sent. A group admin will review your request.
						</div>
						<button
							type="button"
							class="w-full text-center text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
							onclick={handleRequestAgain}
						>
							Didn't hear back? Request again
						</button>
						<div class="space-y-2">
							<div class="flex items-center justify-between">
								<p class="text-xs font-medium text-muted-foreground">Check for invitations</p>
								<Button
									type="button"
									variant="ghost"
									size="icon"
									class="size-7"
									onclick={refreshWelcomes}
									disabled={refreshingWelcomes || !$activeAccount}
								>
									{#if refreshingWelcomes}
										<Spinner class="size-3" />
									{:else}
										<RotateCw class="size-3" />
									{/if}
								</Button>
							</div>
							{#if relatedWelcomes.length > 0}
								{#each relatedWelcomes as notification (notification.id)}
									<WelcomeNotificationCard
										{notification}
										profileHints={welcomeProfileHints}
										coordinatorLabel={getCoordinatorLabel(notification.coordinatorKey)}
										submitting={isWelcomeSubmitting(notification.id)}
										onAccept={() => acceptWelcome(notification.id)}
										onReject={() => rejectWelcome(notification.id)}
									/>
								{/each}
							{/if}
						</div>
					{/if}

					{#if !coordinatorError && !requestSent && relatedWelcomes.length === 0}
						<Button type="button" onclick={handleRequestJoin} disabled={requesting} class="w-full">
							{#if requesting}
								<Spinner class="mr-2 size-4" />
							{:else}
								<MessageCirclePlus class="mr-2 size-4" />
							{/if}
							{requesting ? 'Sending request…' : 'Request to join'}
						</Button>
					{/if}

					{#if requestError}
						<p class="text-sm text-destructive">{requestError}</p>
					{/if}
				</Card.Content>
			</Card.Root>
		</div>
	</div>
{/if}
