<script lang="ts">
	import ChatSidebar from '$lib/components/chat/ChatSidebar.svelte';
	import {
		createChatLayoutContext,
		setChatLayoutContext
	} from '$lib/components/chat/chatLayoutContext';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import { listChatGroups } from '$lib/services/chatGroups.svelte';
	import { startWatchingAllGroups } from '$lib/services/chatGroupWatch.svelte';
	import {
		reconcilePublishedKeyPackagesForActiveAccount,
		shouldReconcilePublishedKeyPackages
	} from '$lib/services/chatKeyPackages.svelte';

	let { children } = $props();
	const chatLayout = setChatLayoutContext(createChatLayoutContext());

	const groups = $derived.by(() => listChatGroups());

	$effect(() => {
		if (!$activeAccount || groups.length === 0) return;
		void startWatchingAllGroups();
	});

	$effect(() => {
		const pubkey = $activeAccount?.pubkey;
		if (!pubkey || !shouldReconcilePublishedKeyPackages(pubkey)) return;
		void reconcilePublishedKeyPackagesForActiveAccount();
	});
</script>

<div class="flex h-dvh min-h-dvh bg-background text-foreground">
	<ChatSidebar mobileSidebarOpen={chatLayout.mobileSidebarOpen} />

	<div class="min-w-0 flex-1 overflow-hidden">
		{@render children()}
	</div>
</div>
