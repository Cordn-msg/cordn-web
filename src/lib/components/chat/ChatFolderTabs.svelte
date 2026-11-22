<script lang="ts">
	import ChatFolderEditDialog from './ChatFolderEditDialog.svelte';
	import { Button } from '$lib/components/ui/button';
	import { getChatGroupSummary } from '$lib/services/chatGroupPresence.svelte';
	import { listChatGroups } from '$lib/services/chatGroups.svelte';
	import {
		chatFolderMatchesGroup,
		getChatFolderSelection,
		getSelectedChatGroupFolder,
		listChatGroupFolders,
		selectChatFolder,
		summarizeChatFolderUnread,
		type ChatFolderSelection
	} from '$lib/services/chatGroupFolders.svelte';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import Check from '@lucide/svelte/icons/check';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Plus from '@lucide/svelte/icons/plus';

	/**
	 * Telegram-style filter strip shared by the chat home and the sidebar:
	 * All / DMs / Groups (derived) + custom folders, horizontally scrollable.
	 * Owns the folder editor for create (“+”) and edit (pencil on a selected
	 * custom folder). Self-hiding below two chats unless a folder exists.
	 *
	 * `scrollElement` is the list's scroll container (the strip sits outside it
	 * on both surfaces, so it cannot find it by walking up). Scrolling down
	 * collapses the strip to reclaim the space; scrolling up — or reaching the
	 * top, where it is actually looked for — brings it back.
	 */
	let { scrollElement = null }: { scrollElement?: HTMLElement | null } = $props();

	const groups = $derived(listChatGroups());
	const folders = $derived(listChatGroupFolders());
	const selected = $derived(getChatFolderSelection());
	const selectedFolder = $derived(getSelectedChatGroupFolder());
	const showTabs = $derived(groups.length >= 2 || folders.length > 0);

	let editorOpen = $state(false);
	let editingFolderId = $state('');

	function openEditor(folderId: string) {
		editingFolderId = folderId;
		editorOpen = true;
	}

	// One cached summary read per group per strip; each tab then sums the
	// message badges of its chats. Mentions stay a separate @ marker because
	// they are already included in unreadCount and must not be added twice.
	const tabs = $derived.by(() => {
		const summaries = new Map(
			groups.map((group) => [group.id, getChatGroupSummary(group.id, $activeAccount?.pubkey)])
		);
		const fixed = (['all', 'dms', 'groups'] as const).map((key) => ({
			key: key as ChatFolderSelection,
			label: key === 'all' ? 'All' : key === 'dms' ? 'DMs' : 'Groups',
			...summarizeChatFolderUnread(
				groups.filter((group) => chatFolderMatchesGroup(key, group)).map((group) => group.id),
				summaries
			)
		}));
		const custom = folders.map((folder) => ({
			key: `folder:${folder.id}` as ChatFolderSelection,
			label: folder.name,
			...summarizeChatFolderUnread(folder.groupIds, summaries)
		}));
		return [...fixed, ...custom];
	});

	const SCROLL_HIDE_PX = 10;
	let collapsed = $state(false);

	$effect(() => {
		const element = scrollElement;
		if (!element) return;
		let lastY = element.scrollTop;
		// Trackpad and momentum deltas are often < 2px per event, so per-event
		// thresholds never fire; accumulate until a whole gesture clears it.
		let accumulated = 0;
		const onScroll = () => {
			const y = element.scrollTop;
			const delta = y - lastY;
			lastY = y;
			if (y <= 8) {
				accumulated = 0;
				collapsed = false;
				return;
			}
			accumulated =
				accumulated === 0 || Math.sign(accumulated) === Math.sign(delta)
					? accumulated + delta
					: delta;
			if (accumulated >= SCROLL_HIDE_PX) {
				accumulated = 0;
				collapsed = true;
			} else if (accumulated <= -SCROLL_HIDE_PX) {
				accumulated = 0;
				collapsed = false;
			}
		};
		element.addEventListener('scroll', onScroll, { passive: true });
		return () => element.removeEventListener('scroll', onScroll);
	});
</script>

{#if showTabs}
	<!-- Height collapse, not display:none, so the list above it eases up instead
	     of jumping; `inert` keeps the hidden controls out of the tab order. -->
	<div
		class={`overflow-hidden transition-all duration-150 ${collapsed ? 'max-h-0 opacity-0' : 'mt-2 max-h-9 opacity-100'}`}
		inert={collapsed || undefined}
	>
		<div class="flex items-center gap-1">
			<div
				class="no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
				role="group"
				aria-label="Filter chats"
			>
				{#each tabs as tab (tab.key)}
					{@const active = tab.key === selected}
					<button
						type="button"
						aria-pressed={active}
						aria-label={`${tab.label}${tab.unreadCount > 0 ? `, ${tab.unreadCount} unread message${tab.unreadCount === 1 ? '' : 's'}` : ''}${tab.hasUnreadReferences ? ', unread mentions' : ''}`}
						onclick={() => selectChatFolder(tab.key)}
						class={`flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors ${active ? 'border-primary bg-primary/10 text-foreground' : 'border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground'}`}
					>
						{#if active}
							<Check class="size-3" aria-hidden="true" />
						{/if}
						<span class="truncate">{tab.label}</span>
						{#if tab.unreadCount > 0}
							<span
								aria-hidden="true"
								class="rounded-full bg-primary px-1 text-[10px] leading-3 font-semibold text-primary-foreground"
							>
								{tab.unreadCount > 99 ? '99+' : tab.unreadCount}
							</span>
						{/if}
						{#if tab.hasUnreadReferences}
							<span
								aria-hidden="true"
								class="rounded-full bg-amber-500 px-1 text-[10px] leading-3 font-semibold text-white"
							>
								@
							</span>
						{/if}
					</button>
				{/each}
			</div>
			{#if selectedFolder}
				<Button
					type="button"
					variant="ghost"
					size="icon"
					class="h-7 w-7 shrink-0 rounded-full"
					onclick={() => openEditor(selectedFolder.id)}
					aria-label={`Edit folder ${selectedFolder.name}`}
					title="Edit folder"
				>
					<Pencil class="size-3.5" />
				</Button>
			{/if}
			<Button
				type="button"
				variant="ghost"
				size="icon"
				class="h-7 w-7 shrink-0 rounded-full"
				onclick={() => openEditor('')}
				aria-label="New folder"
				title="New folder"
			>
				<Plus class="size-3.5" />
			</Button>
		</div>
	</div>

	{#if editorOpen}
		<ChatFolderEditDialog bind:open={editorOpen} folderId={editingFolderId} />
	{/if}
{/if}
