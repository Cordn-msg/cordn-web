import { manager } from '$lib/services/accountManager.svelte';
import { queryClient } from '$lib/query-client';
import { chatQueryKeys } from '$lib/queries/chatQueryKeys';
import { deleteChatGroupsForOwner } from '$lib/services/chatGroups.svelte';
import { deleteChatKeyPackagesForOwner } from '$lib/services/chatKeyPackages.svelte';
import { deleteChatGroupPresenceForOwner } from '$lib/services/chatGroupPresence.svelte';
import { deleteChatGroupPinsForOwner } from '$lib/services/chatGroupPins.svelte';
import { deleteChatPetnamesForOwner } from '$lib/services/chatPetnames.svelte';
import { clearBackgroundGroups } from '$lib/services/nativeBridge';
import { deleteEmojiPacksForOwner } from '$lib/services/chatEmojiPacks.svelte';
import { deleteEmojiCollectionForOwner } from '$lib/services/chatEmojiCollection.svelte';
import {
	deleteJoinRequestsForOwner,
	deleteSentJoinRequestsForOwner
} from '$lib/services/chatJoinRequests.svelte';
import { deleteWelcomeNotificationsForOwner } from '$lib/services/chatWelcomeNotifications.svelte';
import { stopWatchingGroup } from '$lib/services/chatGroupWatch.svelte';
import { disconnectCoordinatorClients } from '$lib/services/chatRuntime';
import { clearMultiDeviceConfig } from '$lib/services/multiDevice.svelte';
import { normalizePubKey } from '$lib/utils';

export async function cleanupActiveAccountChatData(): Promise<void> {
	const account = manager.getActive();
	if (!account) return;

	const ownerPubkey = normalizePubKey(account.pubkey);
	await stopWatchingGroup(undefined, 'logout and clean account data');
	await disconnectCoordinatorClients(account);
	queryClient.removeQueries({ queryKey: chatQueryKeys.account(ownerPubkey) });
	await Promise.all([
		deleteChatGroupsForOwner(ownerPubkey),
		deleteChatKeyPackagesForOwner(ownerPubkey),
		Promise.resolve(deleteChatGroupPresenceForOwner(ownerPubkey)),
		Promise.resolve(deleteChatGroupPinsForOwner(ownerPubkey)),
		Promise.resolve(deleteChatPetnamesForOwner(ownerPubkey)),
		// The native group cache (titles, icons, member labels) outlives the
		// WebView store; a cleaned account must not leak names into a later
		// account's notifications.
		clearBackgroundGroups(ownerPubkey),
		Promise.resolve(deleteEmojiPacksForOwner(ownerPubkey)),
		deleteEmojiCollectionForOwner(ownerPubkey),
		Promise.resolve(deleteWelcomeNotificationsForOwner(ownerPubkey)),
		Promise.resolve(deleteJoinRequestsForOwner(ownerPubkey)),
		Promise.resolve(deleteSentJoinRequestsForOwner(ownerPubkey)),
		Promise.resolve(clearMultiDeviceConfig(ownerPubkey))
	]);
	manager.clearActive();
}
