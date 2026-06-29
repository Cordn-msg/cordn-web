import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import {
	acceptChatWelcome,
	createChatGroup,
	deleteChatGroup,
	getChatGroup,
	inviteChatGroupMember,
	listCoordinatorAvailableKeyPackages,
	recoverPoisonedChatGroup,
	removeChatGroupMember,
	sendChatGroupMessage,
	updateChatGroupMetadata,
	type CoordinatorAvailableKeyPackage
} from '$lib/services/chatGroups.svelte';
import { removeChatGroupPresence } from '$lib/services/chatGroupPresence.svelte';
import {
	chatWelcomeNotificationsStore,
	clearWelcomeSubmitting,
	getWelcomeNotification,
	markWelcomeDismissed,
	setWelcomeSubmitting
} from '$lib/services/chatWelcomeNotifications.svelte';
import {
	acceptJoinRequest,
	chatJoinRequestsStore,
	clearJoinRequestSubmitting,
	getJoinRequest,
	markJoinRequestDismissed,
	setJoinRequestSubmitting
} from '$lib/services/chatJoinRequests.svelte';
import { stopWatchingGroup } from '$lib/services/chatGroupWatch.svelte';
import { getChatGroupResumePromise } from '$lib/services/chatGroupWatchStatus.svelte';
import { queryClient } from '$lib/query-client';
import { chatQueryKeys } from '$lib/queries/chatQueryKeys';
import { fetchCoordinatorAvailableKeyPackages } from '$lib/queries/chatKeyPackageQueries';
import { fetchCoordinatorWelcomeNotifications } from '$lib/queries/chatWelcomeQueries';
import { fetchCoordinatorJoinRequests } from '$lib/queries/chatJoinRequestQueries';
import { requireActiveAccount } from '$lib/services/chatRuntime';
import type {
	ChatMessageDeleteTarget,
	ChatMessageEditTarget,
	ChatMessageReactionTarget,
	ChatMessageReplyTarget,
	StoredChatMessage
} from '$lib/services/chatGroupMessages.svelte';

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

export async function inviteGroupMemberAction(groupId: string | undefined, identifier: string) {
	if (!groupId || chatHeaderActionsStore.inviteSubmitting) return false;
	chatHeaderActionsStore.inviteSubmitting = true;
	chatHeaderActionsStore.error = '';
	try {
		await inviteChatGroupMember({ groupId, identifier });
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
		deleteChatGroup(groupId);
		removeChatGroupPresence(groupId);
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
	const account = requireActiveAccount('You must be logged in to inspect coordinators');
	await queryClient.fetchQuery({
		queryKey: chatQueryKeys.availableKeyPackages(account.pubkey),
		queryFn: () => fetchCoordinatorAvailableKeyPackages(undefined),
		staleTime: 60 * 1000
	});
}

export async function refreshAvailableKeyPackagesAction(coordinatorKey?: string) {
	const account = requireActiveAccount('You must be logged in to inspect coordinators');
	await queryClient.invalidateQueries({
		queryKey: chatQueryKeys.availableKeyPackages(account.pubkey, coordinatorKey)
	});
	await queryClient.fetchQuery({
		queryKey: chatQueryKeys.availableKeyPackages(account.pubkey, coordinatorKey),
		queryFn: () => fetchCoordinatorAvailableKeyPackages(coordinatorKey, { force: true }),
		staleTime: 0
	});
}

export async function sendGroupMessageAction(
	groupId: string | undefined,
	content: string,
	replyTo?: ChatMessageReplyTarget,
	reactionTo?: ChatMessageReactionTarget,
	tags: string[][] = [],
	editTo?: ChatMessageEditTarget,
	deleteTo?: ChatMessageDeleteTarget
): Promise<StoredChatMessage | false> {
	const text = content.trim();
	if ((!text && !reactionTo && !deleteTo) || !groupId) return false;
	chatComposerActionsStore.error = '';
	// If a chat rebuild (the "Updating chats…" resume flow) is in flight, wait
	// for it to settle before sending. This is awaited OUTSIDE the per-group
	// operation lock (acquired inside sendChatGroupMessage): the rebuild's
	// backlog ingestion takes that same lock, so awaiting it from inside would
	// deadlock. The rejection is swallowed so a failed rebuild still gives the
	// send (and its own error path) a chance rather than aborting outright.
	const resumePromise = getChatGroupResumePromise(getChatGroup(groupId)?.coordinatorKey);
	if (resumePromise) {
		await resumePromise.catch(() => undefined);
	}
	try {
		return await sendChatGroupMessage({
			groupId,
			content: reactionTo ? content : text,
			replyTo,
			reactionTo,
			tags,
			editTo,
			deleteTo
		});
	} catch (error) {
		chatComposerActionsStore.error =
			error instanceof Error ? error.message : 'Failed to send message';
		return false;
	}
}

export async function startChatWithKeyPackageAction(keyPackage: {
	kp_ref: string;
	coordinatorKey: string;
}): Promise<string> {
	const group = await createChatGroup({ name: '', coordinatorKey: keyPackage.coordinatorKey });
	await inviteChatGroupMember({ groupId: group.id, identifier: keyPackage.kp_ref });
	return group.id;
}

export async function refreshWelcomeNotificationsAction() {
	const account = requireActiveAccount('You must be logged in to fetch welcomes');
	// A forced fetchQuery fans out to every coordinator and repopulates the
	// cache; mounted observers re-render from the cache write. invalidateQueries
	// here would trigger a SECOND parallel fan-out (the active observer's
	// refetch), doubling welcome_take calls per refresh.
	await queryClient.fetchQuery({
		queryKey: chatQueryKeys.welcomeNotifications(account.pubkey),
		queryFn: () => fetchCoordinatorWelcomeNotifications(account.pubkey, undefined, { force: true }),
		staleTime: 0
	});
}

export async function loadWelcomeNotificationsAction() {
	const account = requireActiveAccount('You must be logged in to fetch welcomes');
	await queryClient.fetchQuery({
		queryKey: chatQueryKeys.welcomeNotifications(account.pubkey),
		queryFn: () => fetchCoordinatorWelcomeNotifications(account.pubkey),
		staleTime: 60 * 1000
	});
}

export async function refreshCoordinatorWelcomeNotificationsAction(coordinatorKey: string) {
	const account = requireActiveAccount('You must be logged in to fetch welcomes');
	await queryClient.invalidateQueries({
		queryKey: chatQueryKeys.welcomeNotifications(account.pubkey, coordinatorKey)
	});
	await queryClient.fetchQuery({
		queryKey: chatQueryKeys.welcomeNotifications(account.pubkey, coordinatorKey),
		queryFn: () =>
			fetchCoordinatorWelcomeNotifications(account.pubkey, coordinatorKey, { force: true }),
		staleTime: 0
	});
}

export async function acceptWelcomeAction(welcomeId: string) {
	chatWelcomeNotificationsStore.error = '';
	setWelcomeSubmitting(welcomeId);
	try {
		const group = await acceptChatWelcome({ welcomeId });
		await goto(resolve('/chat/[id]', { id: group.id }));
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
	const account = requireActiveAccount('You must be logged in to fetch join requests');
	await queryClient.fetchQuery({
		queryKey: chatQueryKeys.joinRequests(account.pubkey),
		queryFn: () => fetchCoordinatorJoinRequests(account.pubkey),
		staleTime: 60 * 1000
	});
}

export async function refreshJoinRequestsAction() {
	const account = requireActiveAccount('You must be logged in to fetch join requests');
	// See refreshWelcomeNotificationsAction: invalidateQueries would double the
	// per-coordinator fan-out. The forced fetchQuery alone repopulates the cache.
	await queryClient.fetchQuery({
		queryKey: chatQueryKeys.joinRequests(account.pubkey),
		queryFn: () => fetchCoordinatorJoinRequests(account.pubkey, undefined),
		staleTime: 0
	});
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
