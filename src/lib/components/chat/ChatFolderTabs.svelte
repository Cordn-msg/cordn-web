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
	 */
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
</script>

{#if showTabs}
	<div class="mt-3 flex items-center gap-1">
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
					class={`flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${active ? 'border-primary bg-primary/10 text-foreground' : 'border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground'}`}
				>
					{#if active}
						<Check class="size-3" aria-hidden="true" />
					{/if}
					<span class="truncate">{tab.label}</span>
					{#if tab.unreadCount > 0}
						<span
							aria-hidden="true"
							class="rounded-full bg-primary px-1.5 text-[10px] leading-4 font-semibold text-primary-foreground"
						>
							{tab.unreadCount > 99 ? '99+' : tab.unreadCount}
						</span>
					{/if}
					{#if tab.hasUnreadReferences}
						<span
							aria-hidden="true"
							class="rounded-full bg-amber-500 px-1.5 text-[10px] leading-4 font-semibold text-white"
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
				class="h-8 w-8 shrink-0 rounded-full"
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
			class="h-8 w-8 shrink-0 rounded-full"
			onclick={() => openEditor('')}
			aria-label="New folder"
			title="New folder"
		>
			<Plus class="size-4" />
		</Button>
	</div>

	{#if editorOpen}
		<ChatFolderEditDialog bind:open={editorOpen} folderId={editingFolderId} />
	{/if}
{/if}
