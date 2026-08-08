<script lang="ts">
	import { untrack } from 'svelte';
	import { page } from '$app/state';
	import AccountLoginDialog from '$lib/components/AccountLoginDialog.svelte';
	import ChatShell from '$lib/components/chat/ChatShell.svelte';
	import WelcomeNotificationCard from '$lib/components/chat/WelcomeNotificationCard.svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Spinner } from '$lib/components/ui/spinner';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import {
		getCoordinatorLabel,
		markCoordinatorUsed,
		upsertChatCoordinator
	} from '$lib/services/chatCoordinators.svelte';
	import { getChatGroup } from '$lib/services/chatGroups.svelte';
	import { ensureLastResortPublished } from '$lib/services/chatKeyPackages.svelte';
	import { promptForeignLastResort } from '$lib/services/lastResortConflict.svelte';
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
	import { resolveGroupLocator } from '$lib/utils/groupShareLink';
	import MessageCirclePlus from '@lucide/svelte/icons/message-circle-plus';
	import RotateCw from '@lucide/svelte/icons/rotate-cw';

	let { params } = $props();

	const locator = $derived.by(() => resolveGroupLocator(params.id, page.url.searchParams));
	const group = $derived.by(() => getChatGroup(locator.gid));
	const groupId = $derived.by(() => locator.gid);
	const coordinatorKey = $derived(locator.coordinatorKey);
	const coordinatorError = $derived(locator.coordinatorError);
	const shareMetadata = $derived(locator.shareMetadata);

	// Auto-register coordinators a share link explicitly carried (cordn1 type 1
	// or legacy `?c=`). Default-coordinator short links carry no coordinator, so
	// they don't upsert.
	$effect(() => {
		if (!locator.coordinatorProvided || locator.coordinatorError) return;
		// Already a member → the coordinator is set up; skip the upsert so internal
		// cordn1 navigation doesn't re-write relays (upsert replaces them) or bump
		// markCoordinatorUsed on every click. Registration is only for genuinely
		// new (non-member) group links.
		if (group) return;
		untrack(() => {
			upsertChatCoordinator({
				pubkey: locator.coordinatorKey,
				relays: locator.relays
			});
			markCoordinatorUsed(locator.coordinatorKey);
		});
	});

	let requesting = $state(false);
	let requestError = $state('');
	let requestSent = $state(untrack(() => hasJoinRequestBeenSent(locator.gid)));
	let requestAfterLogin = $state(false);

	// The [id] route component is reused across /chat/<param> changes (no {#key}),
	// so the one-shot $state above would otherwise leak the previous group's
	// requestSent / requestAfterLogin into the next group opened via a cordn1 link.
	// Re-sync every ephemeral join-card flag to the currently resolved group.
	$effect(() => {
		const gid = locator.gid;
		if (!gid) return;
		untrack(() => {
			requestSent = hasJoinRequestBeenSent(gid);
			requestAfterLogin = false;
			requesting = false;
			requestError = '';
		});
	});

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

		// Capture the group + coordinator at call time. The route component is
		// reused across /chat/<param> changes (no {#key}), so the groupId /
		// coordinatorKey $deriveds can point at a different group by the time the
		// awaits below resolve. Durable writes use the captured values; live UI
		// state is only touched while we're still viewing this group, so a
		// mid-request navigation can't flip the new group's join-card flags.
		const targetGid = groupId;
		const targetCoordinator = coordinatorKey;

		requesting = true;
		requestError = '';

		if (!targetCoordinator) {
			// ponytail: coordinatorError already gates the UI button; this guard
			// keeps handleRequestJoin safe if ever called with a malformed link.
			requestError = 'Cannot request to join: this link has no valid coordinator.';
			requesting = false;
			return;
		}

		try {
			// Ensure a last-resort is published to this coordinator, reusing existing
			// material instead of minting (and evicting) a new one. If another device
			// already published one we don't hold, surface that as a multi-device
			// prompt instead of silently taking over.
			const result = await ensureLastResortPublished(targetCoordinator);
			const keyPackageRef =
				result.kind === 'foreign'
					? await promptForeignLastResort(result.coordinatorKey)
					: result.keyPackageRef;
			if (!keyPackageRef) return;

			await storeJoinRequest(targetCoordinator, targetGid, keyPackageRef);
			markJoinRequestSent(targetGid);
			if (targetGid === locator.gid) {
				requestSent = true;
				void refreshWelcomes();
			}
		} catch (error) {
			if (targetGid === locator.gid) {
				requestError = error instanceof Error ? error.message : 'Failed to request to join group';
			}
		} finally {
			if (targetGid === locator.gid) {
				requesting = false;
			}
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
{:else}
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
						{#if groupId}
							<p class="font-mono text-xs break-all">{groupId}</p>
						{/if}
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
