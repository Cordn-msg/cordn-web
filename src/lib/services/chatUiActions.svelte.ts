import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import {
	acceptChatWelcome,
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
	fetchWelcomeNotifications,
	getWelcomeNotification
} from '$lib/services/chatWelcomeNotifications.svelte';
import {
	chatGroupWatchStore,
	isWatchingGroup,
	startWatchingGroup,
	stopWatchingGroup
} from '$lib/services/chatGroupWatch.svelte';
import type { AvailableKeyPackage } from '$lib/contracts';
import type {
	ChatMessageReactionTarget,
	ChatMessageReplyTarget
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

export const chatWelcomeActionsStore = $state<{
	lastFetchedAccountPubkey: string;
}>({
	lastFetchedAccountPubkey: ''
});

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
	remoteKeyPackages: AvailableKeyPackage[];
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

export async function sendGroupMessageAction(
	groupId: string | undefined,
	content: string,
	replyTo?: ChatMessageReplyTarget,
	reactionTo?: ChatMessageReactionTarget
) {
	const text = content.trim();
	if ((!text && !reactionTo) || !groupId || chatComposerActionsStore.sending) return false;
	chatComposerActionsStore.error = '';
	chatComposerActionsStore.sending = true;
	try {
		await sendChatGroupMessage({
			groupId,
			content: reactionTo ? content : text,
			replyTo,
			reactionTo
		});
		return true;
	} catch (error) {
		chatComposerActionsStore.error =
			error instanceof Error ? error.message : 'Failed to send message';
		return false;
	} finally {
		chatComposerActionsStore.sending = false;
	}
}

export async function loadCoordinatorRemoteKeyPackagesAction(
	client: {
		ListAvailableKeyPackages(args?: object): Promise<{ keyPackages: AvailableKeyPackage[] }>;
	},
	coordinatorKey?: string,
	options: { force?: boolean } = {}
) {
	if (
		!options.force &&
		coordinatorKey &&
		hasLoadedCoordinatorRemoteKeyPackages(coordinatorKey) &&
		!coordinatorDetailsActionsStore.keyPackageError
	) {
		return;
	}

	coordinatorDetailsActionsStore.loadingKeyPackages = true;
	coordinatorDetailsActionsStore.keyPackageError = '';
	try {
		const result = await client.ListAvailableKeyPackages({});
		coordinatorDetailsActionsStore.coordinatorKey = coordinatorKey ?? '';
		coordinatorDetailsActionsStore.remoteKeyPackages = result.keyPackages;
	} catch (error) {
		coordinatorDetailsActionsStore.keyPackageError =
			error instanceof Error ? error.message : 'Failed to load remote key packages';
	} finally {
		coordinatorDetailsActionsStore.loadingKeyPackages = false;
	}
}

export async function refreshWelcomeNotificationsAction() {
	await fetchWelcomeNotifications();
}

export async function refreshCoordinatorWelcomeNotificationsAction(coordinatorKey: string) {
	await fetchWelcomeNotifications([coordinatorKey]);
}

export async function acceptWelcomeAction(welcomeId: string) {
	chatWelcomeNotificationsStore.error = '';
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
	}
}
