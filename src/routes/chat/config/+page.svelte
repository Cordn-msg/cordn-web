<script lang="ts">
	import { resolve } from '$app/paths';
	import AccountLoginDialog from '$lib/components/AccountLoginDialog.svelte';
	import ChatMobileSidebarButton from '$lib/components/chat/ChatMobileSidebarButton.svelte';
	import ProfileCard from '$lib/components/ProfileCard.svelte';
	import BlossomServerConfig from '$lib/components/chat/BlossomServerConfig.svelte';
	import * as Card from '$lib/components/ui/card';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import DatabaseBackup from '@lucide/svelte/icons/database-backup';
	import Bolt from '@lucide/svelte/icons/bolt';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import Server from '@lucide/svelte/icons/server';
</script>

<svelte:head>
	<title>Config | Cordn</title>
	<meta name="description" content="Cordn chat settings placeholder." />
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
				<h1 class="text-lg font-semibold tracking-tight">Config</h1>
				<p class="text-sm text-muted-foreground">Local client preferences placeholder</p>
			</div>
		</div>
	</header>

	<div class="flex-1 overflow-y-auto px-4 py-6 md:px-6 md:py-8">
		<div class="lg:grid-cols mx-auto grid max-w-4xl gap-6">
			<div class="space-y-6">
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
						</div>
					</Card.Content>
				</Card.Root>

				<BlossomServerConfig />
			</div>
		</div>
	</div>
</div>
