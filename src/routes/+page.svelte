<script lang="ts">
	import { resolve } from '$app/paths';
	import AccountLoginDialog from '$lib/components/AccountLoginDialog.svelte';
	import ProfileCard from '$lib/components/ProfileCard.svelte';
	import { activeAccount } from '$lib/services/accountManager.svelte';

	const principles = [
		'Private group chats with strong end-to-end security',
		'An identity model based on keys, not usernames and passwords',
		'Flexible hosting that can be public, self-hosted, or moved when needed'
	];

	const highlights = [
		{
			title: 'What Cordn is',
			body: 'Cordn is a private group chat built for people who want strong encryption without handing all control to one big platform.'
		},
		{
			title: 'Why it matters',
			body: 'Most secure messaging tools are either hard to host yourself or hard to move away from. Cordn is designed to keep security strong while making hosting much more practical.'
		},
		{
			title: 'Who it is for',
			body: 'Teams, communities, and builders who want encrypted group messaging with more freedom over where it runs and who operates it.'
		}
	];
</script>

<svelte:head>
	<title>Cordn</title>
	<meta
		name="description"
		content="Cordn is a private group chat that makes strong encryption easier to use, host, and move."
	/>
</svelte:head>

<div class="min-h-screen bg-background text-foreground">
	<header class="border-b border-border">
		<div class="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
			<a href={resolve('/')} class="flex items-center gap-3 text-lg font-semibold tracking-tight">
				<img src="/cordn-logo-black.svg" alt="Cordn" class="h-8 w-auto dark:hidden" />
				<img src="/cordn-logo.svg" alt="Cordn" class="hidden h-8 w-auto dark:block" />
				<span>Cordn</span>
			</a>

			<nav class="hidden items-center gap-6 text-sm text-muted-foreground md:flex">
				<a href="#why" class="transition-colors hover:text-foreground">Why Cordn</a>
				<a href="#how" class="transition-colors hover:text-foreground">How it works</a>
				<a href="#overview" class="transition-colors hover:text-foreground">Overview</a>
			</nav>

			<a
				href={resolve('/chat')}
				class="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
			>
				Open chat
			</a>
			{#if $activeAccount}
				<div class="hidden items-center gap-2 sm:flex sm:gap-3">
					<ProfileCard pubkey={$activeAccount.pubkey} showLogout={true} />
				</div>
			{:else}
				<div class="hidden sm:block">
					<AccountLoginDialog />
				</div>
			{/if}
		</div>
	</header>

	<main>
		<section
			class="mx-auto grid max-w-6xl gap-12 px-6 py-20 lg:grid-cols-[minmax(0,1fr)_minmax(280px,420px)] lg:items-center"
		>
			<div class="space-y-8">
				<div class="space-y-4">
					<p class="text-sm font-medium tracking-[0.2em] text-muted-foreground uppercase">
						Private group chat, without the usual platform lock-in
					</p>
					<h1 class="max-w-3xl text-4xl font-semibold tracking-tight text-balance md:text-6xl">
						Private group messaging that is easier to understand, easier to host, and easier to
						trust.
					</h1>
					<p class="max-w-2xl text-lg leading-8 text-muted-foreground">
						Cordn is a secure group chat for people who want privacy without needing to become
						experts in cryptography or infrastructure. It keeps messages encrypted, keeps groups in
						sync, and gives you more choice over who runs the service.
					</p>
				</div>

				<div class="flex flex-col gap-3 sm:flex-row">
					<a
						href={resolve('/chat')}
						class="inline-flex items-center justify-center rounded-md bg-primary px-5 py-3 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
					>
						Open chat
					</a>
					<a
						href="#why"
						class="inline-flex items-center justify-center rounded-md border border-border bg-background px-5 py-3 text-sm font-medium transition-colors hover:bg-muted"
					>
						Learn why Cordn exists
					</a>
				</div>

				<ul class="grid gap-3 text-sm text-muted-foreground">
					{#each principles as principle (principle)}
						<li
							class="flex items-start gap-3 rounded-lg border border-border bg-card px-4 py-3 text-card-foreground"
						>
							<span class="mt-0.5 text-base leading-none text-foreground">•</span>
							<span>{principle}</span>
						</li>
					{/each}
				</ul>
			</div>

			<div class="flex justify-center lg:justify-end">
				<div
					class="flex w-full max-w-sm items-center justify-center rounded-3xl border border-border bg-card/70 p-8 shadow-sm backdrop-blur-sm"
				>
					<img
						src="/cordn-logo-black.svg"
						alt="Cordn logo"
						class="w-full max-w-[240px] dark:hidden"
					/>
					<img
						src="/cordn-logo.svg"
						alt="Cordn logo"
						class="hidden w-full max-w-[240px] dark:block"
					/>
				</div>
			</div>
		</section>

		<section id="why" class="border-y border-border bg-muted/30">
			<div class="mx-auto max-w-6xl px-6 py-16">
				<div class="max-w-3xl space-y-4">
					<p class="text-sm font-medium tracking-[0.2em] text-muted-foreground uppercase">
						Why Cordn
					</p>
					<h2 class="text-3xl font-semibold tracking-tight md:text-4xl">
						Cordn keeps secure group chat practical in the real world.
					</h2>
					<p class="text-base leading-7 text-muted-foreground">
						Secure group messaging still needs a service that helps keep everyone on the same page.
						Cordn accepts that reality, then improves it by making that service easier to host,
						move, and run on your own terms.
					</p>
				</div>

				<div class="mt-10 grid gap-6 md:grid-cols-3">
					{#each highlights as highlight (highlight.title)}
						<article class="rounded-2xl border border-border bg-background p-6">
							<h3 class="text-lg font-medium tracking-tight">{highlight.title}</h3>
							<p class="mt-3 text-sm leading-7 text-muted-foreground">{highlight.body}</p>
						</article>
					{/each}
				</div>
			</div>
		</section>

		<section id="how" class="mx-auto max-w-6xl px-6 py-16">
			<div class="max-w-2xl space-y-4">
				<p class="text-sm font-medium tracking-[0.2em] text-muted-foreground uppercase">
					How it works
				</p>
				<h2 class="text-3xl font-semibold tracking-tight md:text-4xl">
					How Cordn works, in plain language.
				</h2>
				<p class="text-base leading-7 text-muted-foreground">
					Cordn combines strong encryption for the group, a coordinator that keeps messages in the
					right order, and a transport model that makes hosting more flexible than a typical public
					internet service.
				</p>
			</div>

			<div class="mt-10 grid gap-4 md:grid-cols-3">
				<div class="rounded-2xl border border-border p-6">
					<p class="text-sm text-muted-foreground">01</p>
					<h3 class="mt-2 text-lg font-medium">You control your identity</h3>
					<p class="mt-3 text-sm leading-7 text-muted-foreground">
						Cordn uses keys instead of a normal account system, so identity stays closer to the user
						instead of living inside a platform database.
					</p>
				</div>
				<div class="rounded-2xl border border-border p-6">
					<p class="text-sm text-muted-foreground">02</p>
					<h3 class="mt-2 text-lg font-medium">The group stays in sync</h3>
					<p class="mt-3 text-sm leading-7 text-muted-foreground">
						A coordinator helps the group receive changes in a clear order, which matters for secure
						group messaging and makes the chat experience much more reliable.
					</p>
				</div>
				<div class="rounded-2xl border border-border p-6">
					<p class="text-sm text-muted-foreground">03</p>
					<h3 class="mt-2 text-lg font-medium">Hosting is more flexible</h3>
					<p class="mt-3 text-sm leading-7 text-muted-foreground">
						You can use a hosted coordinator, run your own, or move to another one later. That means
						you are not forced into a single provider forever.
					</p>
				</div>
			</div>
		</section>

		<section id="overview" class="border-t border-border">
			<div class="mx-auto grid max-w-6xl gap-8 px-6 py-16 md:grid-cols-[1fr_0.9fr]">
				<div class="space-y-4">
					<p class="text-sm font-medium tracking-[0.2em] text-muted-foreground uppercase">
						What this means for you
					</p>
					<h2 class="text-3xl font-semibold tracking-tight md:text-4xl">
						A friendlier path into private group messaging.
					</h2>
					<p class="text-base leading-7 text-muted-foreground">
						Cordn is for people who want strong privacy, but also want something grounded in how
						real systems have to work. It does not promise magic. It offers a clearer tradeoff:
						encrypted group chat with more control over identity, hosting, and portability.
					</p>
				</div>

				<div class="rounded-2xl border border-border bg-card p-6">
					<div class="space-y-5 text-sm leading-7 text-muted-foreground">
						<div>
							<p class="font-medium text-card-foreground">Private by design</p>
							<p>
								Your messages stay encrypted for the group instead of being readable by the service.
							</p>
						</div>
						<div>
							<p class="font-medium text-card-foreground">Built for real deployment</p>
							<p>
								Cordn keeps the coordination secure group chat needs, but makes it easier to host
								and move.
							</p>
						</div>
						<div>
							<p class="font-medium text-card-foreground">More user freedom</p>
							<p>
								You can start with a hosted service and still keep a path toward self-hosting later.
							</p>
						</div>
					</div>
				</div>
			</div>
		</section>
	</main>
</div>
