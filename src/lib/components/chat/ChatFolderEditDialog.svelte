<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import ChatGroupAvatar from './ChatGroupAvatar.svelte';
	import { getChatGroupDisplayTitle } from './chatGroupDisplay';
	import { listChatGroups, listChatGroupMembers } from '$lib/services/chatGroups.svelte';
	import {
		CHAT_FOLDER_NAME_MAX,
		createChatGroupFolder,
		deleteChatGroupFolder,
		listChatGroupFolders,
		updateChatGroupFolder
	} from '$lib/services/chatGroupFolders.svelte';
	import { useProfileHints } from '$lib/services/useProfileHints.svelte';
	import { metadataRelays } from '$lib/services/relay-pool';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import { normalizePubKey } from '$lib/utils';
	import Trash2 from '@lucide/svelte/icons/trash-2';

	/**
	 * Telegram-style folder editor: a name plus a checkbox list of chats.
	 * `folderId` empty = create; `preselectGroupId` pre-checks one chat when
	 * creating from a chat's action menu; `selectOnCreate` switches the list
	 * filter to the fresh folder only when opened from the tab strip's “+”.
	 */
	let {
		open = $bindable(false),
		folderId = '',
		preselectGroupId = '',
		selectOnCreate = true
	}: {
		open?: boolean;
		folderId?: string;
		preselectGroupId?: string;
		selectOnCreate?: boolean;
	} = $props();

	let name = $state('');
	let memberIds = $state<string[]>([]);
	let error = $state('');
	let confirmingDelete = $state(false);

	// Snapshot the folder once per open (not per keystroke) — otherwise a
	// concurrent folder write would clobber the in-editor edits.
	let wasOpen = false;
	$effect(() => {
		if (open && !wasOpen) {
			const folder = folderId
				? listChatGroupFolders().find((entry) => entry.id === folderId)
				: undefined;
			name = folder?.name ?? '';
			memberIds = folder ? [...folder.groupIds] : preselectGroupId ? [preselectGroupId] : [];
			error = '';
			confirmingDelete = false;
		}
		wasOpen = open;
	});

	const groups = $derived(listChatGroups());

	// DM rows display the other member's name: resolve profiles for every
	// group's non-self members once for the whole list (modal-scoped, like
	// ChatGroupActions does per group).
	const profileHints = useProfileHints(
		() => {
			const activePubkey = $activeAccount ? normalizePubKey($activeAccount.pubkey) : '';
			return [
				...new Set(
					groups.flatMap((group) =>
						listChatGroupMembers(group.id)
							.map((member) => normalizePubKey(member.stablePubkey))
							.filter((pubkey): pubkey is string => Boolean(pubkey) && pubkey !== activePubkey)
					)
				)
			];
		},
		{ relays: metadataRelays }
	);

	const titleFor = $derived.by(() => {
		const byGroup = new Map(
			groups.map((group) => [
				group.id,
				getChatGroupDisplayTitle({
					group,
					activePubkey: $activeAccount?.pubkey,
					profileHints,
					memberPubkeys: listChatGroupMembers(group.id).map((member) =>
						normalizePubKey(member.stablePubkey)
					)
				})
			])
		);
		return (groupId: string) => byGroup.get(groupId) ?? 'Group chat';
	});

	function toggleMember(groupId: string) {
		memberIds = memberIds.includes(groupId)
			? memberIds.filter((id) => id !== groupId)
			: [...memberIds, groupId];
	}

	function save() {
		const result = folderId
			? updateChatGroupFolder(folderId, name, memberIds)
			: createChatGroupFolder(name, memberIds, selectOnCreate);
		if (result.error) {
			error = result.error;
			return;
		}
		open = false;
	}

	function remove() {
		deleteChatGroupFolder(folderId);
		open = false;
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-[425px]">
		<Dialog.Header>
			<Dialog.Title>{folderId ? 'Edit folder' : 'New folder'}</Dialog.Title>
			<Dialog.Description>
				Folders are lists of chats kept on this device. Chats are never moved or deleted — they stay
				in All too.
			</Dialog.Description>
		</Dialog.Header>
		<div class="flex flex-col gap-4">
			<div class="space-y-1.5">
				<label class="text-sm font-medium" for="chat-folder-name">Name</label>
				<Input
					id="chat-folder-name"
					bind:value={name}
					maxlength={CHAT_FOLDER_NAME_MAX}
					placeholder="Work"
				/>
				{#if error}
					<p class="text-xs text-destructive" role="alert">{error}</p>
				{/if}
			</div>
			<div class="space-y-1.5">
				<p class="text-sm font-medium">Chats</p>
				<div class="max-h-64 space-y-1 overflow-y-auto">
					{#each groups as group (group.id)}
						{@const member = memberIds.includes(group.id)}
						<label
							class={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-sm transition-colors ${member ? 'border-primary/60 bg-primary/5' : 'border-border hover:bg-muted/40'}`}
						>
							<input
								type="checkbox"
								class="h-4 w-4 shrink-0 rounded border-border"
								checked={member}
								onchange={() => toggleMember(group.id)}
							/>
							<ChatGroupAvatar {group} class="h-8 w-8" fallbackClass="text-xs font-medium" />
							<span class="truncate">{titleFor(group.id)}</span>
						</label>
					{/each}
				</div>
			</div>
		</div>
		<Dialog.Footer>
			{#if folderId}
				{#if confirmingDelete}
					<Button variant="destructive" size="sm" class="mr-auto" onclick={remove}>
						<Trash2 class="mr-1 size-4" />
						Delete folder?
					</Button>
				{:else}
					<Button
						variant="ghost"
						size="sm"
						class="mr-auto text-destructive hover:text-destructive"
						onclick={() => (confirmingDelete = true)}
					>
						<Trash2 class="mr-1 size-4" />
						Delete
					</Button>
				{/if}
			{/if}
			<Button variant="outline" onclick={() => (open = false)}>Cancel</Button>
			<Button onclick={save} disabled={!name.trim()}>
				{folderId ? 'Save' : 'Create'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
