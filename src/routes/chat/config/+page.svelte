<script lang="ts">
	import { resolve } from '$app/paths';
	import AccountLoginDialog from '$lib/components/AccountLoginDialog.svelte';
	import ChatMobileSidebarButton from '$lib/components/chat/ChatMobileSidebarButton.svelte';
	import ProfileCard from '$lib/components/ProfileCard.svelte';
	import * as Card from '$lib/components/ui/card';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import DatabaseBackup from '@lucide/svelte/icons/database-backup';
	import Bolt from '@lucide/svelte/icons/bolt';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import Server from '@lucide/svelte/icons/server';
	import Images from '@lucide/svelte/icons/images';
	import Smartphone from '@lucide/svelte/icons/smartphone';
	import Bell from '@lucide/svelte/icons/bell';
	import { isNativePlatform } from '$lib/services/nativeBridge';
	import { browser } from '$app/environment';
	import { Button } from '$lib/components/ui/button';
	import Moon from '@lucide/svelte/icons/moon';
	import Sun from '@lucide/svelte/icons/sun';
	import { setMode } from 'mode-watcher';

	let isDarkMode = $state(browser ? document.documentElement.classList.contains('dark') : false);

	function toggleTheme() {
		// State sync happens in the MutationObserver below.
		setMode(isDarkMode ? 'light' : 'dark');
	}

	const themeLabel = $derived.by(() =>
		isDarkMode ? 'Switch to light theme' : 'Switch to dark theme'
	);

	$effect(() => {
		if (!browser) return;

		const root = document.documentElement;
		const updateTheme = () => {
			isDarkMode = root.classList.contains('dark');
		};

		updateTheme();

		const observer = new MutationObserver(updateTheme);
		observer.observe(root, { attributes: true, attributeFilter: ['class'] });

		return () => observer.disconnect();
	});
</script>

<svelte:head>
	<title>Settings | Cordn</title>
	<meta name="description" content="Cordn settings." />
</svelte:head>

<div class="flex h-full min-h-0 flex-col bg-background text-foreground">
	<header class="border-b border-border bg-background/95 px-4 py-3 backdrop-blur md:px-6">
		<div class="flex items-center gap-3">
			<ChatMobileSidebarButton />
			<div
				class="flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-card"
			>
				<Bolt class="size-4" />
			</div>
			<div>
				<h1 class="text-lg font-semibold tracking-tight">Settings</h1>
			</div>
			<div class="ml-auto">
				<Button
					type="button"
					variant="outline"
					size="icon"
					class="h-10 w-10 rounded-xl"
					aria-label={themeLabel}
					title={themeLabel}
					onclick={toggleTheme}
				>
					<Sun
						class="h-[1.2rem] w-[1.2rem] scale-100 rotate-0 transition-all! dark:scale-0 dark:-rotate-90"
					/>
					<Moon
						class="absolute h-[1.2rem] w-[1.2rem] scale-0 rotate-90 transition-all! dark:scale-100 dark:rotate-0"
					/>
				</Button>
			</div>
		</div>
	</header>

	<div class="min-h-0 flex-1 overflow-y-auto px-4 py-6 md:px-6 md:py-8">
		<div class="lg:grid-cols mx-auto grid max-w-4xl gap-6">
			<div class="min-w-0 space-y-6">
				<Card.Root>
					<Card.Header>
						<Card.Title>Identity</Card.Title>
						<Card.Description
							>Manage the active account used for local Cordn chat state.</Card.Description
						>
					</Card.Header>
					<Card.Content>
						{#if $activeAccount}
							<ProfileCard
								pubkey={$activeAccount.pubkey}
								mode="extended"
								showLogout={true}
								logoutButtonVariant="destructive"
							/>
						{:else}
							<div class="space-y-3">
								<p class="text-sm text-muted-foreground">
									Log in to manage your identity and local client preferences.
								</p>
								<AccountLoginDialog />
							</div>
						{/if}
					</Card.Content>
				</Card.Root>

				<Card.Root>
					<Card.Header>
						<Card.Title>Chat configuration</Card.Title>
						<Card.Description
							>Persist reusable coordinators and locally generated MLS key packages.</Card.Description
						>
					</Card.Header>
					<Card.Content>
						<div class="grid gap-3 sm:grid-cols-2">
							<a href={resolve('/chat/coordinators')} class="block">
								<div
									class="rounded-2xl border border-border bg-background px-4 py-4 transition-colors hover:bg-muted/50"
								>
									<div
										class="mb-3 flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-card"
									>
										<Server class="size-4" />
									</div>
									<p class="font-medium">Coordinators</p>
									<p class="mt-1 text-sm text-muted-foreground">
										Manage coordinator profiles, relays, defaults, and remote inspection.
									</p>
								</div>
							</a>

							<a href={resolve('/chat/config/key-packages')} class="block">
								<div
									class="rounded-2xl border border-border bg-background px-4 py-4 transition-colors hover:bg-muted/50"
								>
									<div
										class="mb-3 flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-card"
									>
										<KeyRound class="size-4" />
									</div>
									<p class="font-medium">Key packages</p>
									<p class="mt-1 text-sm text-muted-foreground">
										Generate MLS key packages locally and inspect what is available.
									</p>
								</div>
							</a>

							<a href={resolve('/chat/config/backup')} class="block">
								<div
									class="rounded-2xl border border-border bg-background px-4 py-4 transition-colors hover:bg-muted/50"
								>
									<div
										class="mb-3 flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-card"
									>
										<DatabaseBackup class="size-4" />
									</div>
									<p class="font-medium">Backup & recovery</p>
									<p class="mt-1 text-sm text-muted-foreground">
										Export and import your account, group secrets, and coordinators.
									</p>
								</div>
							</a>

							<a href={resolve('/chat/config/multi-device')} class="block">
								<div
									class="rounded-2xl border border-border bg-background px-4 py-4 transition-colors hover:bg-muted/50"
								>
									<div
										class="mb-3 flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-card"
									>
										<Smartphone class="size-4" />
									</div>
									<p class="font-medium">Multi-device sync</p>
									<p class="mt-1 text-sm text-muted-foreground">
										Share your groups across devices of the same identity.
									</p>
								</div>
							</a>

							{#if isNativePlatform()}
								<a href={resolve('/chat/config/notifications')} class="block">
									<div
										class="rounded-2xl border border-border bg-background px-4 py-4 transition-colors hover:bg-muted/50"
									>
										<div
											class="mb-3 flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-card"
										>
											<Bell class="size-4" />
										</div>
										<p class="font-medium">Notifications</p>
										<p class="mt-1 text-sm text-muted-foreground">
											How Cordn checks for new messages in the background.
										</p>
									</div>
								</a>
							{/if}

							<a href={resolve('/chat/config/media')} class="block">
								<div
									class="rounded-2xl border border-border bg-background px-4 py-4 transition-colors hover:bg-muted/50"
								>
									<div
										class="mb-3 flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-card"
									>
										<Images class="size-4" />
									</div>
									<p class="font-medium">Media</p>
									<p class="mt-1 text-sm text-muted-foreground">
										Blossom server used for encrypted image and file uploads.
									</p>
								</div>
							</a>
						</div>
					</Card.Content>
				</Card.Root>
			</div>
		</div>
	</div>
</div>
