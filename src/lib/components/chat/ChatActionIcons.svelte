<script lang="ts">
	import { resolve } from '$app/paths';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { browser } from '$app/environment';
	import QrCode from '$lib/components/QrCode.svelte';
	import WelcomeNotificationsPanel from '$lib/components/chat/WelcomeNotificationsPanel.svelte';
	import NewConversationDialog from '$lib/components/chat/NewConversationDialog.svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Button } from '$lib/components/ui/button';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import { getUnreadWelcomeNotificationCount } from '$lib/services/chatWelcomeNotifications.svelte';
	import { useWelcomeNotifications } from '$lib/queries/chatWelcomeQueries';
	import { nip19 } from 'nostr-tools';
	import Bolt from '@lucide/svelte/icons/bolt';
	import Copy from '@lucide/svelte/icons/copy';
	import Inbox from '@lucide/svelte/icons/inbox';
	import Menu from '@lucide/svelte/icons/menu';
	import Plus from '@lucide/svelte/icons/plus';
	import QrCodeIcon from '@lucide/svelte/icons/qr-code';

	let {
		collapsed = false,
		onNavigate = () => {}
	}: {
		collapsed?: boolean;
		onNavigate?: () => void;
	} = $props();

	let notificationsOpen = $state(false);
	let profileShareOpen = $state(false);
	let copiedProfileLink = $state(false);
	let newConversationOpen = $state(false);

	const unreadWelcomeNotifications = $derived.by(() => getUnreadWelcomeNotificationCount());
	useWelcomeNotifications($activeAccount?.pubkey);

	const profileSharePath = $derived.by(() => {
		if (!$activeAccount) return '';
		return resolve('/p/[identifier]', { identifier: nip19.npubEncode($activeAccount.pubkey) });
	});
	const profileShareUrl = $derived.by(() => {
		if (!profileSharePath) return '';
		return browser ? new URL(profileSharePath, page.url).toString() : profileSharePath;
	});

	function isActive(href: string) {
		return page.url.pathname === href;
	}

	function getNotificationsButtonLabel() {
		if (unreadWelcomeNotifications > 0) {
			return `${unreadWelcomeNotifications} unread welcome${unreadWelcomeNotifications === 1 ? '' : 's'}`;
		}
		return 'No unread welcomes';
	}

	async function copyProfileShareUrl() {
		if (!profileShareUrl || !browser) return;
		await navigator.clipboard.writeText(profileShareUrl);
		copiedProfileLink = true;
		setTimeout(() => {
			copiedProfileLink = false;
		}, 1500);
	}

	async function navigateToConfig() {
		onNavigate();
		await goto(resolve('/chat/config'));
	}
</script>

{#if collapsed}
	<div class="flex justify-center">
		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<Button
						{...props}
						type="button"
						variant="ghost"
						size="icon"
						class="h-12 w-12 rounded-xl"
						aria-label="Open actions"
						title="Open actions"
					>
						<Menu class="size-5" />
					</Button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="end" class="w-56">
				<DropdownMenu.Item onclick={() => (newConversationOpen = true)} class="gap-2">
					<Plus class="size-4" />
					<span>New conversation</span>
				</DropdownMenu.Item>

				<DropdownMenu.Item onclick={() => (notificationsOpen = true)} class="gap-2">
					<span class="relative flex items-center">
						<Inbox class="size-4" />
						{#if unreadWelcomeNotifications > 0}
							<span
								class="ml-2 min-w-5 rounded-full bg-primary px-1.5 py-0.5 text-center text-[10px] leading-none font-semibold text-primary-foreground"
							>
								{unreadWelcomeNotifications}
							</span>
						{/if}
					</span>
					<span>Notifications</span>
				</DropdownMenu.Item>

				{#if $activeAccount}
					<DropdownMenu.Item onclick={() => (profileShareOpen = true)} class="gap-2">
						<QrCodeIcon class="size-4" />
						<span>Share profile</span>
					</DropdownMenu.Item>
				{/if}

				<DropdownMenu.Item onclick={navigateToConfig} class="gap-2">
					<Bolt class="size-4" />
					<span>Config</span>
				</DropdownMenu.Item>
			</DropdownMenu.Content>
		</DropdownMenu.Root>
	</div>
{:else}
	<div class="grid gap-2 {$activeAccount ? 'grid-cols-4' : 'grid-cols-3'}">
		<button
			type="button"
			onclick={() => (newConversationOpen = true)}
			class="flex items-center justify-center rounded-xl border border-transparent px-3 py-3 text-sm text-muted-foreground transition-colors hover:border-border hover:bg-background hover:text-foreground"
			aria-label="New conversation"
			title="New conversation"
		>
			<div
				class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border bg-background"
			>
				<Plus class="size-4" />
			</div>
		</button>

		<button
			type="button"
			onclick={() => (notificationsOpen = true)}
			class="relative flex items-center justify-center rounded-xl border px-3 py-3 text-sm transition-colors {notificationsOpen
				? 'border-primary bg-primary/10 text-foreground'
				: 'border-transparent text-muted-foreground hover:border-border hover:bg-background hover:text-foreground'}"
			aria-label="Open notifications"
			title={getNotificationsButtonLabel()}
		>
			<div
				class="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border bg-background"
			>
				<Inbox class="size-4" />
				{#if unreadWelcomeNotifications > 0}
					<span
						class="absolute -top-1 -right-1 min-w-5 rounded-full bg-primary px-1.5 py-0.5 text-center text-[10px] leading-none font-semibold text-primary-foreground"
					>
						{unreadWelcomeNotifications}
					</span>
				{/if}
			</div>
		</button>

		{#if $activeAccount}
			<button
				type="button"
				onclick={() => (profileShareOpen = true)}
				class="flex items-center justify-center rounded-xl border px-3 py-3 text-sm transition-colors {profileShareOpen
					? 'border-primary bg-primary/10 text-foreground'
					: 'border-transparent text-muted-foreground hover:border-border hover:bg-background hover:text-foreground'}"
				aria-label="Share profile"
				title="Share profile"
			>
				<div
					class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border bg-background"
				>
					<QrCodeIcon class="size-4" />
				</div>
			</button>
		{/if}

		<a
			href={resolve('/chat/config')}
			onclick={onNavigate}
			class="flex items-center justify-center rounded-xl border px-3 py-3 text-sm transition-colors {isActive(
				'/chat/config'
			)
				? 'border-primary bg-primary/10 text-foreground'
				: 'border-transparent text-muted-foreground hover:border-border hover:bg-background hover:text-foreground'}"
			aria-label="Open config"
			title="Open config"
		>
			<div
				class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border bg-background"
			>
				<Bolt class="size-4" />
			</div>
		</a>
	</div>
{/if}

<Dialog.Root bind:open={notificationsOpen}>
	<Dialog.Content class="max-h-[90vh] w-[min(calc(100vw-1.5rem),42rem)] sm:max-w-2xl">
		<Dialog.Header>
			<Dialog.Description>
				Unified inbox for welcomes fetched across known coordinators.
			</Dialog.Description>
		</Dialog.Header>

		<WelcomeNotificationsPanel maxHeightClass="h-[min(26rem,60vh)]" />
	</Dialog.Content>
</Dialog.Root>

{#if $activeAccount}
	<Dialog.Root bind:open={profileShareOpen}>
		<Dialog.Content class="sm:max-w-md">
			<Dialog.Header>
				<Dialog.Title>Share your profile</Dialog.Title>
				<Dialog.Description>Share your public Cordn profile link as a QR code.</Dialog.Description>
			</Dialog.Header>

			<div class="flex flex-col items-center gap-4 py-2">
				<QrCode data={profileShareUrl} size={220} />
				<p
					class="w-full rounded-xl border border-border bg-muted/30 px-3 py-2 text-xs break-all text-muted-foreground"
				>
					{profileShareUrl}
				</p>
				<Button type="button" variant="outline" class="w-full" onclick={copyProfileShareUrl}>
					<Copy class="mr-2 size-4" />
					{copiedProfileLink ? 'Copied profile link' : 'Copy profile link'}
				</Button>
			</div>
		</Dialog.Content>
	</Dialog.Root>
{/if}

<NewConversationDialog bind:open={newConversationOpen} {onNavigate} />
