<script lang="ts">
	import AccountLoginDialog from '$lib/components/AccountLoginDialog.svelte';
	import ChatGroupListItem from '$lib/components/chat/ChatGroupListItem.svelte';
	import ChatMobileSidebarButton from '$lib/components/chat/ChatMobileSidebarButton.svelte';
	import ChatSearchBar from '$lib/components/chat/ChatSearchBar.svelte';
	import LoggedOutIntro from '$lib/components/chat/LoggedOutIntro.svelte';
	import NewConversationDialog from '$lib/components/chat/NewConversationDialog.svelte';
	import NewsListItem from '$lib/components/news/NewsListItem.svelte';
	import * as Card from '$lib/components/ui/card';
	import * as Dialog from '$lib/components/ui/dialog';
	import { browser } from '$app/environment';
	import { isAndroidNative } from '$lib/services/nativeBridge';
	import { hasConfirmedBackup, hasSeenIntro, markIntroSeen } from '$lib/services/onboarding.svelte';
	import { hasJoinRequestBeenSent } from '$lib/services/chatJoinRequests.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Spinner } from '$lib/components/ui/spinner';
	import { resolve } from '$app/paths';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import { DEFAULT_CHAT_COORDINATOR_PUBKEY } from '$lib/constants/chat';
	import { migrationBannerStore } from '$lib/services/migrationBanner.svelte';
	import { areChatGroupsLoaded, listChatGroups } from '$lib/services/chatGroups.svelte';
	import { getUnreadNewsCount, isNewsItemUnread } from '$lib/news/newsReadState.svelte';
	import { getNewsFeedItems } from '$lib/news/feedItems';
	import { maintainReachability, reachabilityStore } from '$lib/services/chatKeyPackages.svelte';
	import { getCoordinatorLabel } from '$lib/services/chatCoordinators.svelte';
	import { toast } from 'svelte-sonner';
	import {
		getChatGroupSummary,
		markAllChatGroupsRead
	} from '$lib/services/chatGroupPresence.svelte';
	import { getGroupActivityAt } from '$lib/components/chat/chatGroupDisplay';
	import { isChatGroupPinned } from '$lib/services/chatGroupPins.svelte';
	import { buildGroupSharePath } from '$lib/utils/groupShareLink';
	import { safeNormalizePubKey } from '$lib/utils';
	import { groupRouteId } from '$lib/services/chatGroupLinks.svelte';
	import { pullToRefresh } from '$lib/actions/pullToRefresh';
	import { refreshChatFeedAction } from '$lib/services/chatUiActions.svelte';
	import { appUpdateStore, reloadForUpdate } from '$lib/services/appUpdate.svelte';
	import CheckCheck from '@lucide/svelte/icons/check-check';
	import BookOpen from '@lucide/svelte/icons/book-open';
	import LinkIcon from '@lucide/svelte/icons/link';
	import UserRoundPlus from '@lucide/svelte/icons/user-round-plus';
	import Users from '@lucide/svelte/icons/users';

	// Pull-to-refresh on the chat list (native shell + standalone PWA only — a plain
	// browser tab keeps the browser's own PTR as the emergency reload). When a web
	// deploy is already known, the pull installs it instead of refreshing data.
	const chatListPullToRefresh = {
		onRefresh: async () => {
			if (appUpdateStore.available) {
				reloadForUpdate();
				return;
			}
			await refreshChatFeedAction();
		},
		label: () => (appUpdateStore.available ? 'Release to update' : null)
	};

	const groups = $derived.by(() => listChatGroups());
	const newsUnreadCount = $derived.by(() => getUnreadNewsCount());
	const newsFeedItems = getNewsFeedItems();
	// News sorts exactly like a chat: its "last activity" is the newest unread
	// release's date (or the newest release once read), so livelier chats
	// naturally bubble above it and it never pins.
	const newsActivityAt = $derived.by(() => {
		const pool = newsFeedItems.filter(isNewsItemUnread);
		const items = pool.length > 0 ? pool : newsFeedItems;
		return items.reduce((latest, item) => Math.max(latest, item.createdAt), 0);
	});
	// Rows sort exactly like chats: pinned groups hold the top, then unread
	// items bubble up (newest first within the tier); read items settle by their
	// last activity. News participates with the same rule, so it is never pinned
	// above a group with newer unread activity.
	type FeedRow =
		| { kind: 'news'; unread: boolean; activityAt: number }
		| {
				kind: 'group';
				group: ReturnType<typeof listChatGroups>[number];
				unread: boolean;
				activityAt: number;
		  };
	const feedRows = $derived.by(() => {
		const rows: FeedRow[] = groups.map((group) => {
			const summary = getChatGroupSummary(group.id, $activeAccount?.pubkey);
			return {
				kind: 'group' as const,
				group,
				unread: summary.unreadCount > 0 || summary.unreadReferenceCount > 0,
				activityAt: getGroupActivityAt(group)
			};
		});
		if (newsFeedItems.length > 0) {
			rows.push({
				kind: 'news',
				unread: newsUnreadCount > 0,
				activityAt: newsActivityAt
			});
		}
		const isRowPinned = (row: FeedRow) => row.kind === 'group' && isChatGroupPinned(row.group.id);
		return rows.sort(
			(a, b) =>
				Number(isRowPinned(b)) - Number(isRowPinned(a)) ||
				Number(b.unread) - Number(a.unread) ||
				b.activityAt - a.activityAt
		);
	});
	const hasUnreadChats = $derived(feedRows.some((row) => row.kind === 'group' && row.unread));
	const hasAccount = $derived.by(() => Boolean($activeAccount));
	// Web-only storage disclaimer: browser storage is the source of truth on web,
	// so warn once (dismiss is permanent — the fact is about the browser, not the
	// account). Hidden entirely in the Android native app, where it is false.
	const WEB_STORAGE_DISCLAIMER_KEY = 'cordn.webStorageDisclaimerDismissed';
	let storageDisclaimerDismissed = $state(
		browser ? localStorage.getItem(WEB_STORAGE_DISCLAIMER_KEY) === '1' : false
	);
	const showStorageDisclaimer = $derived.by(
		() => hasAccount && !isAndroidNative() && !storageDisclaimerDismissed
	);
	function dismissStorageDisclaimer() {
		localStorage.setItem(WEB_STORAGE_DISCLAIMER_KEY, '1');
		storageDisclaimerDismissed = true;
	}
	const hasGroups = $derived.by(() => groups.length > 0);
	// Do not flash the first-run hero while the account's groups are still loading.
	const showEmptyState = $derived.by(() => {
		void groups.length;
		return hasAccount && areChatGroupsLoaded() && !hasGroups;
	});
	const backupConfirmed = $derived.by(() => hasConfirmedBackup($activeAccount?.pubkey));
	const joinRequestSent = $derived.by(() => {
		void $activeAccount?.pubkey;
		return hasJoinRequestBeenSent(CORDN_GROUP_ID);
	});
	let introAuto = $state(!hasSeenIntro());
	let introReplay = $state(false);

	$effect(() => {
		if (!hasAccount) introReplay = false;
	});
	let newConversationOpen = $state(false);
	let newConversationInitialJoin = $state(false);

	function dismissIntro() {
		markIntroSeen();
		introAuto = false;
	}

	function openNewConversation(joinOpen: boolean) {
		newConversationInitialJoin = joinOpen;
		newConversationOpen = true;
	}
	// Reachability callout: shown while any known coordinator VERIFIES that no
	// key package for the active identity is published there — people on that
	// coordinator cannot invite the user. Truth comes from the maintain pass's
	// verified summary (an unreachable coordinator never triggers), and with
	// auto-publish on the callout doubles as its failure surface. Dismiss is
	// permanent and per browser (like the storage disclaimer) — republishing
	// later stays possible via the key-package config page. Suppressed when the
	// migration banner detects the identity is already reachable from another
	// device — that case has its own (link/restore) UX and publishing here would
	// trigger a destructive last-resort take-over.
	// ponytail: dismissal is global, not per-account; key it by pubkey if
	// multi-account users complain about the callout staying hidden.
	const REACHABILITY_DISMISSED_KEY = 'cordn.reachabilityCalloutDismissed';
	let reachabilityCalloutDismissed = $state(
		browser ? localStorage.getItem(REACHABILITY_DISMISSED_KEY) === '1' : false
	);
	function dismissReachabilityCallout() {
		localStorage.setItem(REACHABILITY_DISMISSED_KEY, '1');
		reachabilityCalloutDismissed = true;
	}
	const uncoveredCoordinatorLabels = $derived.by(() =>
		reachabilityStore.uncoveredCoordinatorKeys.map((key) => getCoordinatorLabel(key))
	);
	const showReachabilityCallout = $derived.by(
		() =>
			hasAccount &&
			reachabilityStore.checked &&
			reachabilityStore.ownerPubkey === safeNormalizePubKey($activeAccount?.pubkey ?? '') &&
			reachabilityStore.uncoveredCoordinatorKeys.length > 0 &&
			!migrationBannerStore.detected &&
			!reachabilityCalloutDismissed
	);
	// ponytail: no anti-flash gate, so a multi-device user on a brand-new device may
	// see this callout briefly before migrationBannerStore.detected settles. Add a
	// probeComplete flag to migrationBannerStore if it bothers anyone.

	// Official Cordn discussion group. Encoded as a cordn1 ref (coordinator packed
	// in) plus the `m=` name preview; the default coordinator is embedded, not
	// omitted, so the link is self-contained and portable across clients.
	const CORDN_GROUP_ID = '48ea0377-8a10-4383-9129-a928ceae0232';
	const cordnGroupHref = buildGroupSharePath({
		groupId: CORDN_GROUP_ID,
		coordinatorKey: DEFAULT_CHAT_COORDINATOR_PUBKEY,
		metadata: { name: 'Cordn' }
	});
	const inCordnGroup = $derived.by(() => groups.some((group) => group.id === CORDN_GROUP_ID));
	let makingReachable = $state(false);
	let reachabilityError = $state('');

	async function makeReachable() {
		try {
			makingReachable = true;
			reachabilityError = '';
			// Explicit action overrides the auto-publish opt-out.
			await maintainReachability({ publish: true });
			if (reachabilityStore.uncoveredCoordinatorKeys.length > 0) {
				reachabilityError = `Still unreachable on ${uncoveredCoordinatorLabels.join(', ')}.`;
				return;
			}
			toast.success('You are reachable', {
				description: 'Others can now start private conversations with you.'
			});
		} catch (error) {
			reachabilityError = error instanceof Error ? error.message : 'Failed to publish key package';
		} finally {
			makingReachable = false;
		}
	}

	function getGroupHref(groupId: string) {
		return resolve('/chat/[id]', { id: groupRouteId(groupId) });
	}
</script>

<svelte:head>
	<meta name="description" content="Your Cordn chats." />
</svelte:head>

<div class="flex h-full min-h-0 flex-col bg-background text-foreground">
	<header class="border-b border-border bg-background/95 px-4 py-3 backdrop-blur md:px-6">
		<div class="mx-auto flex w-full max-w-6xl items-center gap-3">
			<ChatMobileSidebarButton />
			{#if hasAccount}
				<h1 class="text-lg font-semibold tracking-tight">Chats</h1>
				<div class="ml-auto flex items-center gap-2">
					{#if hasUnreadChats}
						<Button
							type="button"
							variant="ghost"
							size="icon"
							class="h-9 w-9 shrink-0 rounded-lg"
							aria-label="Mark all chats read"
							title="Mark all chats read"
							onclick={markAllChatGroupsRead}
						>
							<CheckCheck class="size-4" />
						</Button>
					{/if}
					<ChatSearchBar />
				</div>
			{/if}
		</div>
	</header>

	<div
		class="flex-1 overflow-y-auto px-4 py-6 md:px-6 md:py-8"
		use:pullToRefresh={chatListPullToRefresh}
	>
		{#if hasAccount}
			<div class="mx-auto flex max-w-6xl flex-col gap-6">
				{#if showEmptyState}
					<!-- The empty state is the onboarding: one action, three ways in,
					     and a quiet reminder that a key without a copy is a lost key. -->
					<div
						class="flex flex-col items-center gap-6 rounded-2xl border border-border bg-card p-6 text-center md:p-8"
					>
						<div class="space-y-2">
							<h2 class="text-xl font-semibold tracking-tight">No chats yet.</h2>
							<p class="text-sm text-muted-foreground">
								Start a conversation, or join the Cordn group to see how it feels.
							</p>
						</div>

						{#if joinRequestSent}
							<div class="flex flex-col items-center gap-2">
								<p class="text-sm text-muted-foreground">
									Request sent — an admin will let you in.
								</p>
								<Button href={cordnGroupHref} variant="outline">Open the Cordn group</Button>
							</div>
						{:else}
							<div class="flex flex-col items-center gap-2">
								<Button href={cordnGroupHref}>Join the Cordn group</Button>
								<p class="text-xs text-muted-foreground">
									An admin lets you in — you can keep going while you wait.
								</p>
							</div>
						{/if}

						<div class="grid w-full gap-2 sm:grid-cols-3">
							<button
								type="button"
								class="flex flex-col items-center gap-1 rounded-xl border border-border px-3 py-4 transition-colors hover:bg-muted/40"
								onclick={() => openNewConversation(false)}
							>
								<UserRoundPlus class="mb-1 size-5 text-muted-foreground" aria-hidden="true" />
								<span class="text-sm font-medium">Find people</span>
								<span class="text-xs text-muted-foreground">Anyone you can reach</span>
							</button>
							<a
								href={resolve('/chat/create-group')}
								class="flex flex-col items-center gap-1 rounded-xl border border-border px-3 py-4 transition-colors hover:bg-muted/40"
							>
								<Users class="mb-1 size-5 text-muted-foreground" aria-hidden="true" />
								<span class="text-sm font-medium">Create group</span>
								<span class="text-xs text-muted-foreground">Invite people you know</span>
							</a>
							<button
								type="button"
								class="flex flex-col items-center gap-1 rounded-xl border border-border px-3 py-4 transition-colors hover:bg-muted/40"
								onclick={() => openNewConversation(true)}
							>
								<LinkIcon class="mb-1 size-5 text-muted-foreground" aria-hidden="true" />
								<span class="text-sm font-medium">Open a link</span>
								<span class="text-xs text-muted-foreground">Paste a cordn1 link</span>
							</button>
						</div>

						<div class="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-sm">
							{#if $activeAccount?.type === 'nsec' && !backupConfirmed}
								<a
									href={resolve('/chat/config/backup')}
									class="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
								>
									Save a copy of your account
								</a>
							{/if}
							<button
								type="button"
								class="inline-flex items-center gap-1.5 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
								onclick={() => (introReplay = true)}
							>
								<BookOpen class="size-3.5" aria-hidden="true" />
								How Cordn works
							</button>
						</div>
					</div>
				{/if}
				{#if showReachabilityCallout}
					<Card.Root>
						<Card.Header class="space-y-1.5">
							<Card.Title>You're not reachable everywhere</Card.Title>
							<Card.Description>
								You can join and create chats, but people on {uncoveredCoordinatorLabels.join(', ')}
								can't start a private conversation with you until a key package is published there. It
								only takes a second.
							</Card.Description>
						</Card.Header>
						<Card.Content class="space-y-3">
							{#if reachabilityError}
								<p class="text-sm text-destructive">{reachabilityError}</p>
							{/if}
							<div class="flex flex-wrap items-center gap-3">
								<Button onclick={makeReachable} disabled={makingReachable}>
									{#if makingReachable}
										<Spinner class="mr-2 size-4" />
									{/if}
									{makingReachable ? 'Setting up…' : 'Make me reachable'}
								</Button>
								<Button variant="ghost" class="ml-auto" onclick={dismissReachabilityCallout}>
									Dismiss
								</Button>
							</div>
						</Card.Content>
					</Card.Root>
				{/if}

				<!-- Flat feed: group/news rows are self-sufficient bordered cards — no
     outer card chrome or duplicate "Chats" heading (the page header owns
     it), so the content surface stays as wide as possible. -->
				{#if feedRows.length > 0}
					<div class="space-y-3">
						{#each feedRows as row (row.kind === 'news' ? 'news' : row.group.id)}
							{#if row.kind === 'news'}
								<NewsListItem
									href={resolve('/chat/news')}
									variant="card"
									unreadCount={newsUnreadCount}
								/>
							{:else}
								{@const summary = getChatGroupSummary(row.group.id, $activeAccount?.pubkey)}
								<ChatGroupListItem
									group={row.group}
									href={getGroupHref(row.group.id)}
									preview={summary.preview}
									unreadCount={summary.unreadCount}
									unreadReferenceCount={summary.unreadReferenceCount}
								/>
							{/if}
						{/each}
					</div>
				{/if}
				{#if hasGroups}
					<div class="flex flex-wrap items-center gap-2">
						<Button href={resolve('/chat/create-group')} variant="outline">Create group</Button>
						{#if !inCordnGroup}
							<Button href={cordnGroupHref} variant="outline">Join Cordn group</Button>
						{/if}
						<a
							href={resolve('/chat/config')}
							class="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
						>
							Manage coordinators &amp; key packages →
						</a>
					</div>
				{/if}

				{#if showStorageDisclaimer && hasGroups}
					<p
						class="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-center text-xs text-muted-foreground"
					>
						<span>
							Chats are kept in this browser.
							<a
								href={resolve('/chat/config/backup')}
								class="underline underline-offset-2 hover:text-foreground">Back up</a
							>
							to keep them.
						</span>
						<button
							type="button"
							class="underline underline-offset-2 hover:text-foreground"
							onclick={dismissStorageDisclaimer}
						>
							Dismiss
						</button>
					</p>
				{/if}
			</div>
		{:else if introAuto}
			<LoggedOutIntro onSkip={dismissIntro} onStart={markIntroSeen} />
		{:else}
			<div
				class="mx-auto flex min-h-full w-full max-w-md flex-col items-center justify-center gap-6 py-8 text-center"
			>
				<div class="space-y-3">
					<h1 class="text-2xl font-semibold tracking-tight">Welcome to Cordn</h1>
					<p class="text-sm text-muted-foreground">
						Private group messaging, end-to-end encrypted. Your identity is a key you hold — no
						email, no phone number.
					</p>
				</div>
				<AccountLoginDialog
					triggerLabel="Get started"
					triggerVariant="default"
					triggerClass="h-11 px-8 text-base"
				/>
				<div class="flex flex-col items-center gap-2 text-sm">
					<button
						type="button"
						class="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
						onclick={() => (introAuto = true)}
					>
						How Cordn works
					</button>
					<a
						href={resolve('/')}
						class="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
					>
						What is Cordn?
					</a>
				</div>
			</div>
		{/if}
	</div>

	{#if hasAccount}
		<Dialog.Root bind:open={introReplay}>
			<Dialog.Content
				aria-label="How Cordn works"
				showCloseButton={false}
				class="h-dvh max-h-none w-full max-w-none rounded-none p-0 pt-safe pb-safe sm:max-w-none"
			>
				<LoggedOutIntro replay onSkip={() => (introReplay = false)} />
			</Dialog.Content>
		</Dialog.Root>
	{/if}

	<NewConversationDialog
		bind:open={newConversationOpen}
		initialJoinOpen={newConversationInitialJoin}
	/>
</div>
