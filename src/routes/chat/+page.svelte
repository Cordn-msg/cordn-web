<script lang="ts">
	import AccountLoginDialog from '$lib/components/AccountLoginDialog.svelte';
	import QuickActions from '$lib/components/chat/QuickActions.svelte';
	import ChatGroupListItem from '$lib/components/chat/ChatGroupListItem.svelte';
	import ChatMobileSidebarButton from '$lib/components/chat/ChatMobileSidebarButton.svelte';
	import NewsListItem from '$lib/components/news/NewsListItem.svelte';
	import * as Card from '$lib/components/ui/card';
	import { browser } from '$app/environment';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import { isAndroidNative } from '$lib/services/nativeBridge';
	import { Button } from '$lib/components/ui/button';
	import { Spinner } from '$lib/components/ui/spinner';
	import { toast } from 'svelte-sonner';
	import { resolve } from '$app/paths';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import { DEFAULT_CHAT_COORDINATOR_PUBKEY } from '$lib/constants/chat';
	import { getDefaultChatCoordinator } from '$lib/services/chatCoordinators.svelte';
	import { migrationBannerStore } from '$lib/services/migrationBanner.svelte';
	import { listChatGroups } from '$lib/services/chatGroups.svelte';
	import { getUnreadNewsCount, isNewsItemUnread } from '$lib/news/newsReadState.svelte';
	import { getNewsFeedItems } from '$lib/news/feedItems';
	import {
		ensureLastResortPublished,
		listChatKeyPackages
	} from '$lib/services/chatKeyPackages.svelte';
	import { promptForeignLastResort } from '$lib/services/lastResortConflict.svelte';
	import { getChatGroupSummary } from '$lib/services/chatGroupPresence.svelte';
	import { getGroupActivityAt } from '$lib/components/chat/chatGroupDisplay';
	import { buildGroupSharePath } from '$lib/utils/groupShareLink';
	import { groupRouteId } from '$lib/services/chatGroupLinks.svelte';
	import { pullToRefresh } from '$lib/actions/pullToRefresh';
	import { refreshChatFeedAction } from '$lib/services/chatUiActions.svelte';
	import { appUpdateStore, reloadForUpdate } from '$lib/services/appUpdate.svelte';

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
	// Rows sort exactly like chats: unread items bubble to the top (newest
	// first within the tier); read items settle by their last activity. News
	// participates with the same rule, so it is never pinned above a group
	// with newer unread activity.
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
		return rows.sort((a, b) => Number(b.unread) - Number(a.unread) || b.activityAt - a.activityAt);
	});
	const keyPackages = $derived.by(() => listChatKeyPackages($activeAccount?.pubkey));
	const defaultCoordinator = $derived.by(() => getDefaultChatCoordinator());
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
	const hasPublishedLastResort = $derived.by(() =>
		keyPackages.some(
			(keyPackage) => keyPackage.isLastResort && keyPackage.publishedCoordinatorKeys.length > 0
		)
	);
	// Reachability callout: shows after login until a last-resort key package is
	// published, so others can invite the user. Dismiss is permanent and per browser
	// (like the storage disclaimer) — republishing later stays possible via the
	// key-package config page. Suppressed when the migration banner
	// detects the identity is already reachable from another device — that case has
	// its own (link/restore) UX and publishing here would trigger a destructive
	// last-resort take-over.
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
	const showReachabilityCallout = $derived.by(
		() =>
			hasAccount &&
			!hasPublishedLastResort &&
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
			// Honor a power user's flagged default if set; otherwise publish to the
			// default coordinator (seeded on first run), so new users never pick one.
			const result = await ensureLastResortPublished(
				defaultCoordinator?.pubkey ?? DEFAULT_CHAT_COORDINATOR_PUBKEY
			);
			if (result.kind === 'foreign') {
				// Another device already made this identity reachable — hand off to the
				// existing non-destructive link/take-over prompt.
				void promptForeignLastResort(result.coordinatorKey);
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
	<title>{hasAccount ? 'Chats' : 'Cordn'} | Cordn</title>
	<meta name="description" content="Your Cordn chats." />
</svelte:head>

<div class="flex h-full min-h-0 flex-col bg-background text-foreground">
	<header class="border-b border-border bg-background/95 px-4 py-4 backdrop-blur md:px-6">
		<div class="mx-auto flex w-full max-w-6xl flex-col gap-4">
			<div class="flex items-start gap-3">
				<ChatMobileSidebarButton />
				{#if hasAccount}
					<div class="space-y-1">
						<h1 class="text-xl font-semibold tracking-tight">Chats</h1>
					</div>
				{/if}
			</div>
		</div>
	</header>

	<div
		class="flex-1 overflow-y-auto px-4 py-6 md:px-6 md:py-8"
		use:pullToRefresh={chatListPullToRefresh}
	>
		{#if hasAccount}
			<div class="mx-auto flex max-w-6xl flex-col gap-6">
				{#if showStorageDisclaimer}
					<Card.Root class="border-amber-500/40 bg-amber-500/5">
						<Card.Header class="space-y-1.5">
							<Card.Title class="flex items-center gap-2">
								<TriangleAlert class="size-4 text-amber-500" />
								Your chats live in this browser
							</Card.Title>
							<Card.Description>
								Cordn on the web keeps your chats, contacts, and settings in this browser's storage.
								Clearing browser data will delete them, and they won't show up in other browsers.
								Back up from Settings, or use the Android app, which keeps your data in its own
								storage.
							</Card.Description>
						</Card.Header>
						<Card.Content class="flex flex-wrap items-center gap-3">
							<Button href={resolve('/chat/config/backup')}>Back up your data</Button>
							<a
								href="https://zapstore.dev/apps/naddr1qqxk7un89e3k7unydchxzursqyv8wumn8ghj7un9d3shjtn6v9c8xar0wfjjuer9wcpzps7xmxansh7cyl8ak3wexws73n8jjpd7xpr8z50dtl34dgg22f0fqvzqqqr7pv6zvfm6"
								target="_blank"
								rel="noreferrer"
								class="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
							>
								Get the app
							</a>
							<Button variant="ghost" class="ml-auto" onclick={dismissStorageDisclaimer}>
								Dismiss
							</Button>
						</Card.Content>
					</Card.Root>
				{/if}
				{#if showReachabilityCallout}
					<Card.Root>
						<Card.Header class="space-y-1.5">
							<Card.Title>No one can invite you yet</Card.Title>
							<Card.Description>
								You can join and create chats, but other people can't start a private conversation
								with you until you publish a key package. It only takes a second.
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

				<QuickActions
					storageKey="cordn.homeQuickActionsOpen"
					layout="horizontal"
					defaultOpen={browser ? !window.matchMedia('(max-width: 767px)').matches : true}
				/>

				<Card.Root>
					<Card.Header>
						<Card.Title>Chats</Card.Title>
					</Card.Header>
					<Card.Content class="space-y-4">
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
						{#if !hasGroups}
							<div
								class="rounded-2xl border border-dashed border-border p-4 text-sm text-muted-foreground"
							>
								No chats yet. Create one or join the Cordn group to get started.
							</div>
						{/if}
					</Card.Content>
					<Card.Footer class="flex-col items-start gap-3 pt-0">
						<div class="flex flex-wrap gap-2">
							<Button
								href={resolve('/chat/create-group')}
								variant={hasGroups ? 'outline' : 'default'}
							>
								Create group
							</Button>
							{#if !inCordnGroup}
								<Button href={cordnGroupHref} variant="outline">Join Cordn group</Button>
							{/if}
						</div>
						<a
							href={resolve('/chat/config')}
							class="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
						>
							Manage coordinators &amp; key packages →
						</a>
					</Card.Footer>
				</Card.Root>
			</div>
		{:else}
			<!-- Logged-out home is the last step of the landing page: one job (get an
			     identity), zero dead ends. The login dialog pre-selects the best tab. -->
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
				<a
					href={resolve('/')}
					class="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
				>
					What is Cordn?
				</a>
			</div>
		{/if}
	</div>
</div>
