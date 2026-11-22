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

	function hasUnreadActivity(groupId: string): boolean {
		const summary = getChatGroupSummary(groupId, $activeAccount?.pubkey);
		return summary.unreadCount > 0 || summary.unreadReferenceCount > 0;
	}

	// Tab badges count CHATS with unread activity (not messages), so the strip
	// never competes with the per-chat unread badges on rows.
	const tabs = $derived.by(() => {
		const fixed = (['all', 'dms', 'groups'] as const).map((key) => ({
			key: key as ChatFolderSelection,
			label: key === 'all' ? 'All' : key === 'dms' ? 'DMs' : 'Groups',
			unreadChats: groups.filter(
				(group) => chatFolderMatchesGroup(key, group) && hasUnreadActivity(group.id)
			).length
		}));
		const custom = folders.map((folder) => ({
			key: `folder:${folder.id}` as ChatFolderSelection,
			label: folder.name,
			unreadChats: folder.groupIds.filter(hasUnreadActivity).length
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
					onclick={() => selectChatFolder(tab.key)}
					class={`flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${active ? 'border-primary bg-primary/10 text-foreground' : 'border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground'}`}
				>
					{#if active}
						<Check class="size-3" aria-hidden="true" />
					{/if}
					<span class="truncate">{tab.label}</span>
					{#if tab.unreadChats > 0}
						<span
							class="rounded-full bg-primary px-1.5 text-[10px] leading-4 font-semibold text-primary-foreground"
						>
							{tab.unreadChats > 99 ? '99+' : tab.unreadChats}
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

	<ChatFolderEditDialog bind:open={editorOpen} folderId={editingFolderId} />
{/if}
