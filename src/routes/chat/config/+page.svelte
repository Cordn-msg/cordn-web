<script lang="ts">
	import AccountLoginDialog from '$lib/components/AccountLoginDialog.svelte';
	import ProfileCard from '$lib/components/ProfileCard.svelte';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { activeAccount } from '$lib/services/accountManager.svelte';
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
		<div class="mx-auto grid max-w-4xl gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
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
							<ProfileCard pubkey={$activeAccount.pubkey} mode="extended" showLogout={true} />
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
							<a href="/chat/coordinators" class="block">
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

							<a href="/chat/config/key-packages" class="block">
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
						</div>
					</Card.Content>
				</Card.Root>
			</div>

			<Card.Root>
				<Card.Header>
					<Card.Title>Overview</Card.Title>
					<Card.Description
						>Use the coordinator hub as the primary operational surface for Cordn transport and
						discovery.</Card.Description
					>
				</Card.Header>
				<Card.Content>
					<div class="space-y-3 text-sm text-muted-foreground">
						<p>
							• Coordinators now model real reachable profiles with relays, defaults, and color
							identity.
						</p>
						<p>
							• The coordinator hub is where users should inspect remote key package directories and
							pending welcomes.
						</p>
						<p>
							• Key packages remain a personal local inventory page, while coordinator pages
							represent remote state.
						</p>
					</div>
				</Card.Content>
				<Card.Footer class="justify-end">
					<Button href="/chat/coordinators" variant="outline">Open coordinator hub</Button>
				</Card.Footer>
			</Card.Root>
		</div>
	</div>
</div>
