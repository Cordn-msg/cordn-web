import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import {
	acceptChatWelcome,
	createChatGroup,
	deleteChatGroup,
	fetchChatGroupMessages,
	inviteChatGroupMember,
	listCoordinatorAvailableKeyPackages,
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
import {
	chatGroupWatchStore,
	isWatchingGroup,
	startWatchingGroup,
	stopWatchingGroup
} from '$lib/services/chatGroupWatch.svelte';
import { queryClient } from '$lib/query-client';
import { chatQueryKeys } from '$lib/queries/chatQueryKeys';
import {
	fetchCoordinatorAvailableKeyPackages,
	type AvailableKeyPackageWithCoordinator
} from '$lib/queries/chatKeyPackageQueries';
import { fetchCoordinatorWelcomeNotifications } from '$lib/queries/chatWelcomeQueries';
import { fetchCoordinatorJoinRequests } from '$lib/queries/chatJoinRequestQueries';
import { requireActiveAccount } from '$lib/services/chatRuntime';
import { SvelteMap } from 'svelte/reactivity';
import type {
	ChatMessageDeleteTarget,
	ChatMessageEditTarget,
	ChatMessageReactionTarget,
	ChatMessageReplyTarget,
	StoredChatMessage
} from '$lib/services/chatGroupMessages.svelte';

export const chatHeaderActionsStore = $state<{
	fetchLoading: boolean;
	inviteOpen: boolean;
	inviteLoading: boolean;
	inviteSubmitting: boolean;
	watchLoading: boolean;
	error: string;
	availableKeyPackages: CoordinatorAvailableKeyPackage[];
}>({
	fetchLoading: false,
	inviteOpen: false,
	inviteLoading: false,
	inviteSubmitting: false,
	watchLoading: false,
	error: '',
	availableKeyPackages: []
});

export const chatGroupInfoActionsStore = $state<{
	removeSubmitting: string;
	deleteSubmitting: boolean;
	metadataSubmitting: boolean;
	error: string;
}>({
	removeSubmitting: '',
	deleteSubmitting: false,
	metadataSubmitting: false,
	error: ''
});

export async function fetchGroupMessagesAction(groupId?: string) {
	if (!groupId || chatHeaderActionsStore.fetchLoading) return;
	chatHeaderActionsStore.fetchLoading = true;
	chatHeaderActionsStore.error = '';
	try {
		await fetchChatGroupMessages(groupId);
	} catch (error) {
		chatHeaderActionsStore.error =
			error instanceof Error ? error.message : 'Failed to fetch messages';
	} finally {
		chatHeaderActionsStore.fetchLoading = false;
	}
}

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

export async function toggleGroupWatchAction(groupId?: string) {
	if (!groupId || chatHeaderActionsStore.watchLoading) return;
	chatHeaderActionsStore.watchLoading = true;
	chatHeaderActionsStore.error = '';
	chatGroupWatchStore.error = '';

	try {
		if (isWatchingGroup(groupId)) {
			await stopWatchingGroup(groupId);
			return;
		}

		await startWatchingGroup(groupId);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Failed to watch group messages';
		chatHeaderActionsStore.error = message;
		chatGroupWatchStore.error = message;
	} finally {
		chatHeaderActionsStore.watchLoading = false;
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

export const chatComposerActionsStore = $state<{
	error: string;
	sending: boolean;
}>({
	error: '',
	sending: false
});

export const coordinatorDetailsActionsStore = $state<{
	coordinatorKey: string;
	loadingKeyPackages: boolean;
	keyPackageError: string;
	remoteKeyPackages: AvailableKeyPackageWithCoordinator[];
}>({
	coordinatorKey: '',
	loadingKeyPackages: false,
	keyPackageError: '',
	remoteKeyPackages: []
});

export function hasLoadedCoordinatorRemoteKeyPackages(coordinatorKey: string) {
	return (
		coordinatorDetailsActionsStore.coordinatorKey === coordinatorKey &&
		coordinatorDetailsActionsStore.remoteKeyPackages.length > 0
	);
}

const remoteKeyPackagesInFlight = new SvelteMap<string, Promise<void>>();

function getRemoteKeyPackagesLoadKey(coordinatorKey?: string) {
	return coordinatorKey ?? 'all-coordinators';
}

function hasLoadedRemoteKeyPackagesForCoordinator(coordinatorKey?: string) {
	return hasLoadedCoordinatorRemoteKeyPackages(coordinatorKey ?? '');
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
	if ((!text && !reactionTo && !deleteTo) || !groupId || chatComposerActionsStore.sending)
		return false;
	chatComposerActionsStore.error = '';
	chatComposerActionsStore.sending = true;
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
	} finally {
		chatComposerActionsStore.sending = false;
	}
}

export async function loadCoordinatorRemoteKeyPackagesAction(
	coordinatorKey?: string,
	options: { force?: boolean } = {}
) {
	const loadKey = getRemoteKeyPackagesLoadKey(coordinatorKey);
	if (
		!options.force &&
		hasLoadedRemoteKeyPackagesForCoordinator(coordinatorKey) &&
		!coordinatorDetailsActionsStore.keyPackageError
	) {
		return;
	}

	const inFlight = remoteKeyPackagesInFlight.get(loadKey);
	if (!options.force && inFlight) return inFlight;

	const request = (async () => {
		coordinatorDetailsActionsStore.loadingKeyPackages = true;
		coordinatorDetailsActionsStore.keyPackageError = '';
		try {
			const account = requireActiveAccount('You must be logged in to inspect coordinators');
			if (options.force) {
				await queryClient.invalidateQueries({
					queryKey: chatQueryKeys.coordinators(account.pubkey)
				});
			}
			const result = await queryClient.fetchQuery({
				queryKey: chatQueryKeys.availableKeyPackages(account.pubkey, coordinatorKey),
				queryFn: () => fetchCoordinatorAvailableKeyPackages(coordinatorKey, options),
				staleTime: options.force ? 0 : 30 * 1000
			});
			coordinatorDetailsActionsStore.coordinatorKey = coordinatorKey ?? '';
			coordinatorDetailsActionsStore.remoteKeyPackages = result;
		} catch (error) {
			coordinatorDetailsActionsStore.keyPackageError =
				error instanceof Error ? error.message : 'Failed to load remote key packages';
		} finally {
			coordinatorDetailsActionsStore.loadingKeyPackages = false;
			remoteKeyPackagesInFlight.delete(loadKey);
		}
	})();

	remoteKeyPackagesInFlight.set(loadKey, request);
	return request;
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
	await queryClient.invalidateQueries({
		queryKey: chatQueryKeys.welcomeNotifications(account.pubkey)
	});
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
	await queryClient.invalidateQueries({
		queryKey: chatQueryKeys.joinRequests(account.pubkey)
	});
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
