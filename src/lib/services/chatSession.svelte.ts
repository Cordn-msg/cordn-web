import { manager } from '$lib/services/accountManager.svelte';
import { queryClient } from '$lib/query-client';
import { chatQueryKeys } from '$lib/queries/chatQueryKeys';
import { deleteChatGroupsForOwner } from '$lib/services/chatGroups.svelte';
import { deleteChatKeyPackagesForOwner } from '$lib/services/chatKeyPackages.svelte';
import { deleteChatGroupPresenceForOwner } from '$lib/services/chatGroupPresence.svelte';
import { deleteWelcomeNotificationsForOwner } from '$lib/services/chatWelcomeNotifications.svelte';
import { stopWatchingGroup } from '$lib/services/chatGroupWatch.svelte';
import { disconnectCoordinatorClients } from '$lib/services/chatRuntime';
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
		Promise.resolve(deleteWelcomeNotificationsForOwner(ownerPubkey))
	]);
	manager.clearActive();
}
