import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import { groupRouteId } from '$lib/services/chatGroupLinks.svelte';
import {
	acceptChatWelcome,
	createChatGroup,
	deleteChatGroup,
	ensureGroupsLoaded,
	inviteChatGroupMember,
	listCoordinatorAvailableKeyPackages,
	recoverPoisonedChatGroup,
	removeChatGroupMember,
	sendChatGroupMessage,
	updateChatGroupMetadata,
	type ChatGroupInviteTarget,
	type CoordinatorAvailableKeyPackage
} from '$lib/services/chatGroups.svelte';
import { removeChatGroupPresence } from '$lib/services/chatGroupPresence.svelte';
import { removeChatGroupPin } from '$lib/services/chatGroupPins.svelte';
import {
	chatWelcomeNotificationsStore,
	clearWelcomeSubmitting,
	getWelcomeNotification,
	isWelcomeSubmitting,
	listWelcomeNotifications,
	markWelcomeDismissed,
	setWelcomeSubmitting
} from '$lib/services/chatWelcomeNotifications.svelte';
import {
	acceptJoinRequest,
	chatJoinRequestsStore,
	clearJoinRequestSubmitting,
	getJoinRequest,
	hasJoinRequestBeenSent,
	listPendingJoinRequests,
	markJoinRequestDismissed,
	setJoinRequestSubmitting
} from '$lib/services/chatJoinRequests.svelte';
import { stopWatchingGroup, refreshWatchedGroups } from '$lib/services/chatGroupWatch.svelte';
import { checkForUpdateNow } from '$lib/services/appUpdate.svelte';
import { isNativePlatform } from '$lib/services/nativeShims';
import { softDeleteGroup, isMultiDeviceActive } from '$lib/services/multiDevice.svelte';
import { getChatGroupResumePromise } from '$lib/services/chatGroupWatchStatus.svelte';
import { queryClient } from '$lib/query-client';
import { chatQueryKeys } from '$lib/queries/chatQueryKeys';
import { fetchCoordinatorAvailableKeyPackages } from '$lib/queries/chatKeyPackageQueries';
import { fetchCoordinatorWelcomeNotifications } from '$lib/queries/chatWelcomeQueries';
import { fetchCoordinatorJoinRequests } from '$lib/queries/chatJoinRequestQueries';
import { requireActiveAccount } from '$lib/services/chatRuntime';
import { ensureLastResortPublished } from '$lib/services/chatKeyPackages.svelte';
import { promptForeignLastResort } from '$lib/services/lastResortConflict.svelte';
import { getDefaultChatCoordinator } from '$lib/services/chatCoordinators.svelte';
import { DEFAULT_CHAT_COORDINATOR_PUBKEY } from '$lib/constants/chat';
import { toast } from 'svelte-sonner';
import type { ChatMessageReplyTarget, MessageTarget, PinOp } from '$lib/chat/references';
import { describeEmojiFailures, emojiMediaTagsForContent } from '$lib/services/chatEmojiMedia';
import type { StoredChatMessage } from '$lib/services/chatGroupMessages.svelte';

export const chatHeaderActionsStore = $state<{
	inviteOpen: boolean;
	inviteLoading: boolean;
	inviteSubmitting: boolean;
	error: string;
	availableKeyPackages: CoordinatorAvailableKeyPackage[];
}>({
	inviteOpen: false,
	inviteLoading: false,
	inviteSubmitting: false,
	error: '',
	availableKeyPackages: []
});

export const chatGroupInfoActionsStore = $state<{
	removeSubmitting: string;
	deleteSubmitting: boolean;
	metadataSubmitting: boolean;
	recoverySubmitting: boolean;
	recoveryResult: 'success' | 'failure' | null;
	error: string;
}>({
	removeSubmitting: '',
	deleteSubmitting: false,
	metadataSubmitting: false,
	recoverySubmitting: false,
	recoveryResult: null,
	error: ''
});

export async function refreshInviteKeyPackagesAction(groupId?: string) {
	if (!groupId) return;
	chatHeaderActionsStore.inviteLoading = true;
	chatHeaderActionsStore.error = '';
	try {
		chatHeaderActionsStore.availableKeyPackages =
			await listCoordinatorAvailableKeyPackages(groupId);
	} catch (error) {
		chatHeaderActionsStore.error =
			error instanceof Error ? error.message : 'Failed to load available key packages';
	} finally {
		chatHeaderActionsStore.inviteLoading = false;
	}
}

export async function inviteGroupMemberAction(
	groupId: string | undefined,
	target: ChatGroupInviteTarget
) {
	if (!groupId || chatHeaderActionsStore.inviteSubmitting) return false;
	chatHeaderActionsStore.inviteSubmitting = true;
	chatHeaderActionsStore.error = '';
	try {
		await inviteChatGroupMember({ groupId, ...target });
		await refreshInviteKeyPackagesAction(groupId);
		chatHeaderActionsStore.inviteOpen = false;
		return true;
	} catch (error) {
		chatHeaderActionsStore.error =
			error instanceof Error ? error.message : 'Failed to invite member';
		return false;
	} finally {
		chatHeaderActionsStore.inviteSubmitting = false;
	}
}

export async function removeGroupMemberAction(
	groupId: string | undefined,
	targetStablePubkey: string
) {
	if (!groupId || chatGroupInfoActionsStore.removeSubmitting) return false;
	chatGroupInfoActionsStore.removeSubmitting = targetStablePubkey;
	chatGroupInfoActionsStore.error = '';
	try {
		await removeChatGroupMember({ groupId, targetStablePubkey });
		return true;
	} catch (error) {
		chatGroupInfoActionsStore.error =
			error instanceof Error ? error.message : 'Failed to remove member';
		return false;
	} finally {
		chatGroupInfoActionsStore.removeSubmitting = '';
	}
}

export async function deleteGroupAction(groupId: string | undefined) {
	if (!groupId || chatGroupInfoActionsStore.deleteSubmitting) return false;
	chatGroupInfoActionsStore.deleteSubmitting = true;
	chatGroupInfoActionsStore.error = '';
	try {
		await stopWatchingGroup(groupId, 'group deleted locally');
		if (isMultiDeviceActive()) {
			// Soft-delete (spec §8/§10): drop locally AND propagate a tombstone so
			// siblings stop tracking it too. The next republish carries it in the
			// §10.5 union. `softDeleteGroup` performs the local drop internally.
			await softDeleteGroup(groupId);
		} else {
			deleteChatGroup(groupId);
		}
		removeChatGroupPresence(groupId);
		removeChatGroupPin(groupId);
		await goto(resolve('/chat'));
		return true;
	} catch (error) {
		chatGroupInfoActionsStore.error =
			error instanceof Error ? error.message : 'Failed to delete group';
		return false;
	} finally {
		chatGroupInfoActionsStore.deleteSubmitting = false;
	}
}

export async function updateGroupMetadataAction(
	groupId: string | undefined,
	input: {
		name: string;
		description?: string;
		icon?: string;
		imageUrl?: string;
		adminPubkeys?: string[];
	}
) {
	if (!groupId || chatGroupInfoActionsStore.metadataSubmitting) return false;
	chatGroupInfoActionsStore.metadataSubmitting = true;
	chatGroupInfoActionsStore.error = '';
	try {
		await updateChatGroupMetadata({ groupId, ...input });
		return true;
	} catch (error) {
		chatGroupInfoActionsStore.error =
			error instanceof Error ? error.message : 'Failed to update group metadata';
		return false;
	} finally {
		chatGroupInfoActionsStore.metadataSubmitting = false;
	}
}

export const chatComposerActionsStore = $state<{ error: string }>({
	error: ''
});

export async function loadAvailableKeyPackagesAction() {
	requireActiveAccount('You must be logged in to inspect coordinators');
	// Direct fan-out: warms every per-coordinator cache entry (the observers'
	// data source) without a throwaway aggregate cache entry.
	await fetchCoordinatorAvailableKeyPackages();
}

export async function refreshAvailableKeyPackagesAction(coordinatorKey?: string) {
	const account = requireActiveAccount('You must be logged in to inspect coordinators');
	if (coordinatorKey?.trim()) {
		await queryClient.invalidateQueries({
			queryKey: chatQueryKeys.availableKeyPackages(account.pubkey, coordinatorKey)
		});
		await queryClient.fetchQuery({
			queryKey: chatQueryKeys.availableKeyPackages(account.pubkey, coordinatorKey),
			queryFn: ({ signal }) =>
				fetchCoordinatorAvailableKeyPackages(coordinatorKey, { force: true, signal }),
			staleTime: 0
		});
		return;
	}
	// Aggregate refresh = forced fan-out over every per-coordinator cache entry.
	await fetchCoordinatorAvailableKeyPackages(undefined, { force: true });
}

/** Shared send wrapper: waits for any in-flight chat rebuild OUTSIDE the
 *  per-group operation lock (the rebuild's backlog ingestion takes that same
 *  lock, so awaiting it from inside would deadlock; rejection is swallowed so a
 *  failed rebuild still gives the send its own error path) and mirrors failures
 *  to the composer error store. */
async function runSend(send: () => Promise<StoredChatMessage>): Promise<StoredChatMessage | false> {
	chatComposerActionsStore.error = '';
	const resumePromise = getChatGroupResumePromise();
	if (resumePromise) {
		await resumePromise.catch(() => undefined);
	}
	try {
		return await send();
	} catch (error) {
		console.error('Failed to send chat message:', error);
		chatComposerActionsStore.error =
			error instanceof Error ? error.message : 'Failed to send message';
		return false;
	}
}

export async function sendGroupMessageAction(
	groupId: string | undefined,
	content: string,
	replyTo?: ChatMessageReplyTarget,
	reactionTo?: MessageTarget,
	tags: string[][] = [],
	editTo?: MessageTarget,
	deleteTo?: MessageTarget,
	pinTo?: MessageTarget,
	pinOp?: PinOp
): Promise<StoredChatMessage | false> {
	const text = content.trim();
	if ((!text && !reactionTo && !deleteTo && !pinTo) || !groupId) return false;
	return runSend(async () => {
		const messageContent = reactionTo ? content : text;
		const emojiMedia = await emojiMediaTagsForContent(groupId, messageContent);
		// Direct sends have no pending bubble to offer a choice on: refuse rather
		// than turn a custom emoji into the bare shortcode behind the person's back.
		if (emojiMedia.failed.length > 0) throw new Error(describeEmojiFailures(emojiMedia.failed));
		return sendChatGroupMessage({
			groupId,
			content: messageContent,
			replyTo,
			reactionTo,
			tags: [...tags, ...emojiMedia.tags],
			mediaKeyBase64: emojiMedia.mediaKeyBase64,
			editTo,
			deleteTo,
			pinTo,
			pinOp
		});
	});
}

/** Cast (or re-cast) a poll vote: a complete-selection replacement for the
 *  poll targeted by `target`, one event per account — latest wins. `content` is
 *  the readable fallback bubble text for clients without poll support. */
export async function castPollVoteAction(
	groupId: string | undefined,
	target: MessageTarget,
	optionIds: string[],
	content = ''
): Promise<StoredChatMessage | false> {
	if (!groupId || optionIds.length === 0) return false;
	return runSend(() => sendChatGroupMessage({ groupId, content, voteTo: { target, optionIds } }));
}

export async function startChatWithKeyPackageAction(keyPackage: {
	kp_ref: string;
	coordinatorKey: string;
	pk: string;
}): Promise<string> {
	await ensureGroupsLoaded();
	const group = await createChatGroup({ name: '', coordinatorKey: keyPackage.coordinatorKey });
	try {
		await inviteChatGroupMember({
			groupId: group.id,
			identifier: keyPackage.kp_ref,
			expectedStablePubkey: keyPackage.pk
		});
	} catch (error) {
		// The group is an implementation detail of this flow: a failed start must
		// not leave an empty junk group behind. (An ambiguous msg_post timeout may
		// still have landed at the coordinator — orphan bytes for a gid only this
		// dead group knew; the invite's own retry semantics own that case.)
		deleteChatGroup(group.id);
		throw error;
	}
	return group.id;
}

/**
 * "Make me reachable": publish a last-resort key package so others can invite
 * the active identity. Shared by the chat-home reachability callout and the
 * profile share dialog. A foreign last-resort hands off to the existing
 * non-destructive link/take-over prompt and publishes nothing here; errors
 * propagate to the caller (each surface reports them differently).
 */
export async function makeReachableAction(coordinatorKey?: string): Promise<void> {
	// With no coordinator given (the generic callout, the bare npub link):
	// honor a power user's flagged default if set; otherwise publish to the
	// default coordinator (seeded on first run), so new users never pick one.
	const result = await ensureLastResortPublished(
		coordinatorKey || getDefaultChatCoordinator()?.pubkey || DEFAULT_CHAT_COORDINATOR_PUBKEY
	);
	if (result.kind === 'foreign') {
		void promptForeignLastResort(result.coordinatorKey);
		return;
	}
	toast.success('You are reachable', {
		description: 'Others can now start private conversations with you.'
	});
}

export async function refreshWelcomeNotificationsAction() {
	const account = requireActiveAccount('You must be logged in to fetch welcomes');
	// The helper fans out per coordinator (forced) and writes each
	// per-coordinator cache entry; mounted observers re-render from those
	// writes. invalidateQueries here would trigger a SECOND parallel fan-out
	// (the observers' refetch), doubling welcome_take calls per refresh.
	await fetchCoordinatorWelcomeNotifications(account.pubkey, undefined, { force: true });
}

/** With no coordinator, every known one (startup); with one, just that leg (a pending join request's own coordinator). */
export async function loadWelcomeNotificationsAction(coordinatorKey?: string) {
	const account = requireActiveAccount('You must be logged in to fetch welcomes');
	await fetchCoordinatorWelcomeNotifications(account.pubkey, coordinatorKey);
}

export async function refreshCoordinatorWelcomeNotificationsAction(coordinatorKey: string) {
	const account = requireActiveAccount('You must be logged in to fetch welcomes');
	await fetchCoordinatorWelcomeNotifications(account.pubkey, coordinatorKey, { force: true });
}

/**
 * `navigate: false` accepts in place (the auto-accept of a requested join): the
 * group appears in the lists on its own, and the reader is not pulled off whatever
 * they were doing.
 */
export async function acceptWelcomeAction(welcomeId: string, options: { navigate?: boolean } = {}) {
	chatWelcomeNotificationsStore.error = '';
	setWelcomeSubmitting(welcomeId);
	try {
		const group = await acceptChatWelcome({ welcomeId });
		// Ack the consumed welcome to the coordinator straight away (carried as
		// the `consumed` array on the next fetch) so other admins stop seeing it
		// instead of waiting for the 5-min poll. Best-effort: the poll retries.
		void refreshWelcomeNotificationsAction().catch(() => {});
		if (options.navigate !== false) {
			await goto(resolve('/chat/[id]', { id: groupRouteId(group.id) }));
		}
		return true;
	} catch (error) {
		const notification = getWelcomeNotification(welcomeId);
		chatWelcomeNotificationsStore.error =
			error instanceof Error
				? error.message
				: `Failed to accept welcome${notification ? ` ${notification.kpRef}` : ''}`;
		return false;
	} finally {
		clearWelcomeSubmitting(welcomeId);
	}
}

/**
 * Accept the Welcomes that answer a join request this account sent. The request
 * was already the consent, so the second confirmation the notifications dialog
 * would ask for is the redundancy this removes. Everything else in the inbox
 * (an invitation, a DM someone started) is left for the reader to accept.
 *
 * Matching is by the group id the Welcome opens into, never by key package: a
 * last-resort package can carry an invitation to any group, so a kp_ref match
 * would silently accept a group the reader never asked for. A Welcome that will
 * not open here (its private material is held by another device) previews to
 * nothing and simply stays a normal invitation.
 *
 * Sequential on purpose: two acceptances in one tick would both write group state
 * and solve nothing by racing. A failed acceptance keeps the Welcome, so the
 * reader still sees it and can accept by hand.
 */
export async function autoAcceptJoinRequestWelcomesAction(): Promise<void> {
	const pending = new Map(listPendingJoinRequests().map((entry) => [entry.gid, entry]));
	if (pending.size === 0) return;

	for (const welcome of listWelcomeNotifications()) {
		const gid = welcome.preview?.gid;
		if (!gid || isWelcomeSubmitting(welcome.id)) continue;
		const entry = pending.get(gid);
		// Re-read: an earlier acceptance in this pass removes its own record.
		if (!entry || !hasJoinRequestBeenSent(gid)) continue;
		// A record written before records carried a coordinator matches on gid alone.
		if (entry.coordinatorKey && entry.coordinatorKey !== welcome.coordinatorKey) continue;

		const label = welcome.preview?.name || entry.name || 'the group';
		if (await acceptWelcomeAction(welcome.id, { navigate: false })) {
			toast.success('You are in', { description: label });
		}
	}
}

export async function rejectWelcomeAction(welcomeId: string) {
	chatWelcomeNotificationsStore.error = '';
	setWelcomeSubmitting(welcomeId);
	try {
		markWelcomeDismissed(welcomeId);
		return true;
	} catch (error) {
		const notification = getWelcomeNotification(welcomeId);
		chatWelcomeNotificationsStore.error =
			error instanceof Error
				? error.message
				: `Failed to reject welcome${notification ? ` ${notification.kpRef}` : ''}`;
		return false;
	} finally {
		clearWelcomeSubmitting(welcomeId);
	}
}

export async function loadJoinRequestsAction() {
	requireActiveAccount('You must be logged in to fetch join requests');
	// Concurrent per-coordinator legs; merges land in the store as each leg
	// settles, so one slow coordinator never gates the rest.
	await fetchCoordinatorJoinRequests();
}

export async function refreshJoinRequestsAction() {
	await fetchCoordinatorJoinRequests({ force: true });
}

/**
 * Pull-to-refresh on the chat list: one catch-up pass over watched groups plus the
 * notification-style remote reads (welcomes, join requests). On web it also rides
 * along a one-shot deploy check — when an update is already known the gesture
 * reloads instead (see the pull-to-refresh label in the chat page).
 */
export async function refreshChatFeedAction(): Promise<void> {
	if (!isNativePlatform()) checkForUpdateNow();
	await Promise.all([
		refreshWatchedGroups().catch(() => {}),
		refreshWelcomeNotificationsAction().catch(() => {}),
		refreshJoinRequestsAction().catch(() => {})
	]);
}

export async function acceptJoinRequestAction(joinRequestId: string) {
	chatJoinRequestsStore.error = '';
	setJoinRequestSubmitting(joinRequestId);
	try {
		const entry = getJoinRequest(joinRequestId);
		if (!entry) {
			throw new Error(`Join request ${joinRequestId} not found`);
		}
		await acceptJoinRequest(entry);
		// Ack the consumed join request to the coordinator straight away so
		// other admins stop seeing it instead of waiting for the 5-min poll.
		// Best-effort: the poll retries.
		void refreshJoinRequestsAction().catch(() => {});
		return true;
	} catch (error) {
		const entry = getJoinRequest(joinRequestId);
		chatJoinRequestsStore.error =
			error instanceof Error
				? error.message
				: `Failed to accept join request${entry ? ` for ${entry.requesterStablePubkey.slice(0, 12)}…` : ''}`;
		return false;
	} finally {
		clearJoinRequestSubmitting(joinRequestId);
	}
}

export async function rejectJoinRequestAction(joinRequestId: string) {
	chatJoinRequestsStore.error = '';
	setJoinRequestSubmitting(joinRequestId);
	try {
		markJoinRequestDismissed(joinRequestId);
		return true;
	} catch (error) {
		const entry = getJoinRequest(joinRequestId);
		chatJoinRequestsStore.error =
			error instanceof Error
				? error.message
				: `Failed to reject join request${entry ? ` for ${entry.requesterStablePubkey.slice(0, 12)}…` : ''}`;
		return false;
	} finally {
		clearJoinRequestSubmitting(joinRequestId);
	}
}

export async function recoverPoisonedGroupAction(groupId?: string) {
	if (!groupId || chatGroupInfoActionsStore.recoverySubmitting) return;
	chatGroupInfoActionsStore.recoverySubmitting = true;
	chatGroupInfoActionsStore.recoveryResult = null;
	chatGroupInfoActionsStore.error = '';
	try {
		const success = await recoverPoisonedChatGroup(groupId);
		chatGroupInfoActionsStore.recoveryResult = success ? 'success' : 'failure';
		if (!success) {
			chatGroupInfoActionsStore.error =
				'Recovery failed. The group state could not be restored from available snapshots.';
		}
	} catch (error) {
		chatGroupInfoActionsStore.recoveryResult = 'failure';
		chatGroupInfoActionsStore.error =
			error instanceof Error ? error.message : 'Failed to recover group';
	} finally {
		chatGroupInfoActionsStore.recoverySubmitting = false;
	}
}
