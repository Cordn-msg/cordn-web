<script lang="ts">
	import { metadataRelays } from '$lib/services/relay-pool';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import { listChatGroupMembers, type StoredChatGroup } from '$lib/services/chatGroups.svelte';
	import {
		formatChatMessagePreviewText,
		getChatGroupDisplayTitle,
		type ChatGroupProfileHints
	} from './chatGroupDisplay';
	import ChatGroupAvatar from './ChatGroupAvatar.svelte';
	import ChatGroupUnreadChips from './ChatGroupUnreadChips.svelte';
	import ChatGroupActions from './ChatGroupActions.svelte';
	import { normalizePubKey } from '$lib/utils';
	import {
		getChatCoordinator,
		getCoordinatorColor,
		getCoordinatorLabel
	} from '$lib/services/chatCoordinators.svelte';
	import { useProfileHints } from '$lib/services/useProfileHints.svelte';
	import { isChatGroupPinned, toggleChatGroupPin } from '$lib/services/chatGroupPins.svelte';
	import Pin from '@lucide/svelte/icons/pin';
	import { toast } from 'svelte-sonner';

	let {
		group,
		href,
		preview,
		unreadCount = 0,
		unreadReferenceCount = 0,
		collapsed = false,
		variant = 'card',
		active = false,
		onclick,
		profileHints
	}: {
		group: StoredChatGroup;
		href: string;
		preview: string;
		unreadCount?: number;
		unreadReferenceCount?: number;
		collapsed?: boolean;
		variant?: 'card' | 'sidebar';
		active?: boolean;
		onclick?: ((event: MouseEvent) => void) | undefined;
		profileHints?: ChatGroupProfileHints;
	} = $props();

	const isSidebar = $derived(variant === 'sidebar');
	const memberPubkeys = $derived.by(() =>
		listChatGroupMembers(group.id)
			.map((member) => normalizePubKey(member.stablePubkey))
			.filter((pubkey): pubkey is string => Boolean(pubkey))
	);

	const groupProfileHints = useProfileHints(
		() => {
			if (profileHints) return [];
			const activePubkey = $activeAccount ? normalizePubKey($activeAccount.pubkey) : '';
			return [...new Set(memberPubkeys.filter((pubkey) => pubkey !== activePubkey))];
		},
		{ relays: metadataRelays }
	);

	const hints = $derived(profileHints ?? groupProfileHints);
	const title = $derived.by(() =>
		getChatGroupDisplayTitle({
			group,
			activePubkey: $activeAccount?.pubkey,
			profileHints: hints,
			memberPubkeys
		})
	);
	const showActions = $derived(!collapsed);
	// Coordinator accent for the sidebar dot, derived internally so no call site
	// threads props. Falls back to the deterministic derived color when the
	// coordinator isn't in the local store.
	const coordinatorAccent = $derived.by(() => {
		const stored = getChatCoordinator(group.coordinatorKey);
		return {
			color: getCoordinatorColor(stored ?? { pubkey: group.coordinatorKey, color: undefined }),
			label: getCoordinatorLabel(group.coordinatorKey)
		};
	});
	const pinned = $derived(isChatGroupPinned(group.id));

	// Long-press (touch/pen) toggles pin — same convention as the message
	// bubbles (400ms hold, cancels on scroll). Any movement beyond the gesture
	// tolerance cancels so list scrolling stays pure.
	const LONG_PRESS_MS = 400;
	const GESTURE_MOVE_TOLERANCE = 10;
	let holdTimer: ReturnType<typeof setTimeout> | null = null;
	let suppressNextClick = false;
	let coarsePointerActive = false;
	let touchStartX = 0;
	let touchStartY = 0;

	function isCoarsePointer(event: PointerEvent) {
		return event.pointerType === 'touch' || event.pointerType === 'pen';
	}

	function cancelHoldTimer() {
		if (holdTimer) {
			clearTimeout(holdTimer);
			holdTimer = null;
		}
	}

	function handlePointerDown(event: PointerEvent) {
		suppressNextClick = false;
		coarsePointerActive = isCoarsePointer(event);
		if (!coarsePointerActive || event.button !== 0) return;
		touchStartX = event.clientX;
		touchStartY = event.clientY;
		cancelHoldTimer();
		holdTimer = setTimeout(() => {
			holdTimer = null;
			suppressNextClick = true;
			toggleChatGroupPin(group.id);
			navigator.vibrate?.(10);
			toast.success(pinned ? 'Pinned to top' : 'Unpinned');
		}, LONG_PRESS_MS);
	}

	function handlePointerMove(event: PointerEvent) {
		if (!holdTimer) return;
		if (
			Math.hypot(event.clientX - touchStartX, event.clientY - touchStartY) > GESTURE_MOVE_TOLERANCE
		) {
			cancelHoldTimer();
		}
	}

	function handlePointerUp() {
		cancelHoldTimer();
	}

	// A fired long-press already toggled the pin; swallow the trailing click so
	// the navigation doesn't also open the group.
	function handleLinkClick(event: MouseEvent) {
		if (suppressNextClick) {
			suppressNextClick = false;
			event.preventDefault();
			event.stopPropagation();
			return;
		}
		onclick?.(event);
	}

	// Anchor is a sibling of the action button (not its parent) so the button
	// click never navigates and we avoid nested interactive elements.
	const linkClass = $derived.by(() => {
		if (isSidebar) {
			return `flex min-w-0 flex-1 items-center gap-3 rounded-xl border px-3 py-3 text-sm transition-colors ${collapsed ? 'justify-center px-2' : 'ml-1'} ${active ? 'border-primary bg-primary/10 text-foreground' : 'border-transparent text-muted-foreground hover:border-border hover:bg-background hover:text-foreground'}`;
		}

		return 'group flex min-w-0 flex-1 items-center gap-3 rounded-2xl border border-border p-4 transition-colors hover:border-foreground/20 hover:bg-muted/30';
	});
	const containerClass = $derived(
		isSidebar ? 'flex items-center gap-1' : 'group flex items-center gap-1'
	);
</script>

<div class={containerClass}>
	<!-- The caller passes route hrefs resolved with $app/paths when route params are needed. -->
	<!-- eslint-disable svelte/no-navigation-without-resolve -->
	<a
		{href}
		onclick={handleLinkClick}
		onpointerdown={handlePointerDown}
		onpointermove={handlePointerMove}
		onpointerup={handlePointerUp}
		onpointercancel={handlePointerUp}
		oncontextmenu={(event) => {
			if (coarsePointerActive) event.preventDefault();
		}}
		class={linkClass}
	>
		{#if isSidebar && active && !collapsed}
			<span
				class="size-1.5 shrink-0 rounded-full"
				style={`background-color: ${coordinatorAccent.color};`}
				title={coordinatorAccent.label}
				aria-hidden="true"
			></span>
		{/if}
		<div class="relative shrink-0">
			<ChatGroupAvatar
				{group}
				class={isSidebar ? 'h-10 w-10' : 'h-12 w-12'}
				fallbackClass={isSidebar ? 'text-sm font-medium' : 'text-base font-medium'}
			/>
			<ChatGroupUnreadChips {unreadCount} {unreadReferenceCount} />
		</div>

		{#if !collapsed}
			<div class="min-w-0 flex-1 overflow-hidden">
				<div
					class={isSidebar ? 'flex items-start justify-between gap-2' : 'flex items-center gap-2'}
				>
					<p class="flex min-w-0 items-center gap-1 font-medium text-foreground">
						{#if pinned}
							<Pin
								class="size-3 shrink-0 text-muted-foreground"
								aria-label="Pinned to top"
								title="Pinned to top"
							/>
						{/if}
						<span class="truncate">{title}</span>
					</p>
					{#if !isSidebar && group.metadata?.description}
						<span class="hidden text-xs text-muted-foreground sm:inline">•</span>
						<p class="hidden truncate text-xs text-muted-foreground sm:block">
							{group.metadata.description}
						</p>
					{/if}
				</div>
				<p
					class={isSidebar
						? 'truncate text-xs leading-5 text-muted-foreground'
						: 'truncate text-sm text-muted-foreground'}
				>
					{formatChatMessagePreviewText(preview, hints)}
				</p>
			</div>
		{/if}
	</a>
	<!-- eslint-enable svelte/no-navigation-without-resolve -->

	{#if showActions}
		<ChatGroupActions {group} {title} profileHints={hints} />
	{/if}
</div>
