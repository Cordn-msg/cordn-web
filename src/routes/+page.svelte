<script lang="ts">
	import { resolve } from '$app/paths';
	import LandingChatPreview from '$lib/components/LandingChatPreview.svelte';
	import Github from '@lucide/svelte/icons/git-branch';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import MessageSquare from '@lucide/svelte/icons/message-square';
	import Server from '@lucide/svelte/icons/server';
	import Shield from '@lucide/svelte/icons/shield';
	import EyeOff from '@lucide/svelte/icons/eye-off';
	import ShieldCheck from '@lucide/svelte/icons/shield-check';
	import { copyToClipboard } from '$lib/utils';

	const principles = [
		'No email or phone number — your identity is a key you hold.',
		'Group messages, end-to-end encrypted and delivered in clear order.',
		'Run it hosted, self-hosted, or for a single session — and move a group whenever you like.'
	];

	const highlights = [
		{
			icon: MessageSquare,
			title: 'Open protocol, not a silo',
			body: 'An open-source client on a published protocol. Nothing about the model is hidden, and you’re never locked to one provider.'
		},
		{
			icon: KeyRound,
			title: 'Identity without account lock-in',
			body: 'Your identity is a Nostr public key — no email, phone, or platform account. Use a stable identity when it matters, or a fresh key for everyday chat.'
		},
		{
			icon: Server,
			title: 'Built to move',
			body: 'Coordinators are easy to run and easy to leave. Start hosted, move to your own, or spin one up for a single conversation — your group isn’t tied to where it lives.'
		}
	];

	const modelCards = [
		{
			step: '01',
			title: 'Coordinator',
			body: 'One coordinator per group keeps MLS state and message order clear. It’s reached through ContextVM, so it never needs to be a conventional public server.',
			linkLabel: 'contextvm.org',
			linkHref: 'https://contextvm.org/'
		},
		{
			step: '02',
			title: 'Nostr relays',
			body: 'Nostr relays carry transport for reaching coordinators. That makes deployment simpler, even behind NATs, firewalls, and more constrained networks.'
		},
		{
			step: '03',
			title: 'Clients',
			body: 'Clients connect through relays to reach coordinators over ContextVM. Messages are encrypted on your device before they leave, then delivered to the group in clear order.'
		}
	];

	const differentiators = [
		{
			icon: EyeOff,
			title: 'Nothing stored on public relays',
			body: 'Your messages never persist on a public relay as Cordn events — the relay only carries generic encrypted traffic. There’s nothing to collect now, or pull from an archive years later.'
		},
		{
			icon: Shield,
			title: 'Read and locate, kept apart',
			body: 'Whoever can read your traffic can’t locate you. Whoever can locate you can’t read your traffic. The service that carries your messages and the network that knows where you’re connecting from never sit in the same hands.'
		},
		{
			icon: Server,
			title: 'You pick the observer',
			body: 'With most chat apps, countless silent parties can watch your metadata forever. With Cordn, one party is in a position to see anything — and if you run your own coordinator, that party is you.'
		},
		{
			icon: ShieldCheck,
			title: 'Your group outlives its coordinator',
			body: 'The coordinator delivers messages — it doesn’t hold your group. If it’s compromised, shut down, or turns hostile, your group, its members, and the history on your devices keep going.'
		}
	];

	const deploymentCommand = 'docker run --rm ghcr.io/cordn-msg/cordn:latest';
</script>

<svelte:head>
	<title>Cordn</title>
	<meta
		name="description"
		content="Cordn is private group messaging you can own, with Nostr-based identity, end-to-end encryption, and flexible deployment."
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
			</nav>

			<a
				href={resolve('/chat')}
				data-sveltekit-preload-data="off"
				class="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
			>
				Open chat
			</a>
		</div>
	</header>
	<main>
		<section
			class="relative mx-auto grid min-h-[calc(100vh-73px)] max-w-6xl gap-12 overflow-hidden px-6 py-20 lg:grid-cols-[minmax(0,1fr)_minmax(280px,420px)] lg:items-center"
		>
			<div
				class="pointer-events-none absolute -top-40 left-1/2 -z-10 h-[40rem] w-[60rem] max-w-[140%] -translate-x-1/2 rounded-full bg-foreground/[0.05] blur-3xl"
				aria-hidden="true"
			></div>
			<div class="space-y-8">
				<div class="space-y-4">
					<p class="text-sm font-medium tracking-[0.2em] text-muted-foreground uppercase">
						Private chat without platform lock-in.
					</p>
					<h1
						class="max-w-3xl bg-gradient-to-b from-foreground to-muted-foreground bg-clip-text text-4xl font-semibold tracking-tight text-balance text-transparent md:text-6xl"
					>
						Private messaging that you own.
					</h1>
					<p class="max-w-2xl text-lg leading-8 text-muted-foreground">
						Private group messaging that leaves nothing on public relays. Messages are end-to-end
						encrypted, identity is just a key — no email or phone number — and you choose where it
						runs: a hosted service, your own machine, or a throwaway session for one conversation.
					</p>
				</div>

				<div class="flex flex-col gap-3 sm:flex-row">
					<a
						href={resolve('/chat')}
						data-sveltekit-preload-data="off"
						class="inline-flex items-center justify-center rounded-md bg-primary px-5 py-3 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
					>
						Open chat
					</a>
					<a
						href="https://github.com/Cordn-msg/cordn"
						target="_blank"
						rel="noreferrer"
						class="inline-flex items-center justify-center gap-2 rounded-md border border-border bg-background px-5 py-3 text-sm font-medium transition-colors hover:bg-muted"
					>
						<Github class="h-4 w-4" />
						<span>View repo</span>
					</a>
					<a
						href="#why"
						class="inline-flex items-center justify-center rounded-md border border-border bg-background px-5 py-3 text-sm font-medium transition-colors hover:bg-muted"
					>
						Learn how Cordn works
					</a>
				</div>

				<div class="space-y-2">
					<p class="text-xs font-medium tracking-[0.2em] text-muted-foreground uppercase">
						Now available for Android
					</p>
					<div class="flex flex-wrap items-center gap-3">
						<a
							href="https://zapstore.dev/apps/naddr1qqxk7un89e3k7unydchxzursqyv8wumn8ghj7un9d3shjtn6v9c8xar0wfjjuer9wcpzps7xmxansh7cyl8ak3wexws73n8jjpd7xpr8z50dtl34dgg22f0fqvzqqqr7pv6zvfm6"
							target="_blank"
							rel="noreferrer"
							class="inline-flex items-center rounded-2xl transition-transform hover:scale-[1.02]"
						>
							<img
								src="/get-it-on-zapstore.svg"
								alt="Get it on Zapstore"
								class="h-14 w-auto"
								width="374"
								height="114"
							/>
						</a>
						<a
							href="https://apps.obtainium.imranr.dev/redirect.html?r=obtainium://add/https://github.com/Cordn-msg/cordn-web"
							target="_blank"
							rel="noreferrer"
							class="inline-flex items-center rounded-2xl transition-transform hover:scale-[1.02]"
						>
							<img
								src="/get-it-on-obtainium.png"
								alt="Get it on Obtainium"
								class="h-14 w-auto"
								width="646"
								height="250"
							/>
						</a>
					</div>
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
				<LandingChatPreview />
			</div>
		</section>

		<section class="border-y border-border bg-muted/30">
			<div class="mx-auto max-w-6xl px-6 py-12">
				<div
					class="grid gap-6 rounded-3xl border border-border bg-background p-6 md:grid-cols-[minmax(0,1fr)_auto] md:items-end"
				>
					<div class="space-y-3">
						<p class="text-sm font-medium tracking-[0.2em] text-muted-foreground uppercase">
							Run your own coordinator
						</p>
						<h2 class="text-2xl font-semibold tracking-tight md:text-3xl">
							Start with one command.
						</h2>
						<p class="max-w-2xl text-sm leading-7 text-muted-foreground">
							Self-hosting is meant to be practical. Start fast with Docker, then see the repo for
							more deployment options, docs, and protocol drafts.
						</p>
					</div>
					<a
						href="https://github.com/Cordn-msg/cordn"
						target="_blank"
						rel="noreferrer"
						class="inline-flex items-center justify-center rounded-md border border-border bg-background px-4 py-2 text-sm font-medium transition-colors hover:bg-muted"
					>
						Deployment docs
					</a>
					<div class="rounded-2xl border border-border bg-card p-4 md:col-span-2">
						<div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
							<pre class="overflow-x-auto text-sm text-foreground"><code>{deploymentCommand}</code
								></pre>
							<button
								type="button"
								onclick={() => copyToClipboard(deploymentCommand)}
								class="inline-flex items-center justify-center rounded-md border border-border bg-background px-4 py-2 text-sm font-medium transition-colors hover:bg-muted"
							>
								Copy command
							</button>
						</div>
					</div>
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
						Open, portable, and yours to run.
					</h2>
					<p class="text-base leading-7 text-muted-foreground">
						Cordn is open source and built on a published protocol, so the model is inspectable and
						portable. Use a hosted coordinator for convenience, or run your own when you want full
						control — your encryption and your group come with you either way.
					</p>
					<a
						href={resolve('/why')}
						class="inline-flex items-center rounded-md border border-border bg-background px-4 py-2 text-sm font-medium transition-colors hover:bg-muted"
					>
						Read more
					</a>
				</div>

				<div class="mt-10 grid gap-6 md:grid-cols-3">
					{#each highlights as highlight (highlight.title)}
						<article
							class="rounded-2xl border border-border bg-background p-6 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md"
						>
							<div
								class="flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-muted text-foreground"
							>
								<highlight.icon class="h-5 w-5" />
							</div>
							<h3 class="text-lg font-medium tracking-tight">{highlight.title}</h3>
							<p class="mt-3 text-sm leading-7 text-muted-foreground">{highlight.body}</p>
						</article>
					{/each}
				</div>
			</div>
		</section>

		<section id="how" class="mx-auto max-w-6xl px-6 py-16">
			<div class="max-w-3xl space-y-4">
				<p class="text-sm font-medium tracking-[0.2em] text-muted-foreground uppercase">
					How it works
				</p>
				<h2 class="text-3xl font-semibold tracking-tight md:text-4xl">
					A simple model for private group chat.
				</h2>
				<p class="text-base leading-7 text-muted-foreground">
					The model is simple: one coordinator per group keeps messages ordered, Nostr relays carry
					the transport, and your device encrypts everything before it leaves.
				</p>
			</div>

			<div class="mt-10 grid gap-4 md:grid-cols-3">
				{#each modelCards as card (card.step)}
					<div
						class="rounded-2xl border border-border p-6 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md"
					>
						<p class="text-sm text-muted-foreground">{card.step}</p>
						<h3 class="mt-2 text-lg font-medium">{card.title}</h3>
						<p class="mt-3 text-sm leading-7 text-muted-foreground">
							{card.body}
							{#if card.linkHref}
								<!-- eslint-disable svelte/no-navigation-without-resolve -->
								<a
									href={card.linkHref}
									target="_blank"
									rel="noreferrer"
									class="underline underline-offset-4"
								>
									{card.linkLabel}
								</a>
								<!-- eslint-enable svelte/no-navigation-without-resolve -->
							{/if}
						</p>
					</div>
				{/each}
			</div>
		</section>

		<section id="overview" class="border-t border-border bg-muted/30">
			<div class="mx-auto max-w-6xl px-6 py-16">
				<div class="max-w-3xl space-y-4">
					<p class="text-sm font-medium tracking-[0.2em] text-muted-foreground uppercase">
						What this means for your privacy
					</p>
					<h2 class="text-3xl font-semibold tracking-tight md:text-4xl">
						Privacy that’s built in, not bolted on.
					</h2>
					<p class="text-base leading-7 text-muted-foreground">
						Most private messengers encrypt what you say but leave the rest — who’s talking, when,
						and a recognizable protocol fingerprint — sitting on public relays for anyone to
						collect. Cordn’s design shrinks that surface by architecture, not by promise. It’s open
						source and in beta — see the
						<a
							href="https://github.com/Cordn-msg/cordn"
							target="_blank"
							rel="noreferrer"
							class="underline underline-offset-4">coordinator</a
						>
						and the
						<a
							href="https://github.com/Cordn-msg/cordn-web"
							target="_blank"
							rel="noreferrer"
							class="underline underline-offset-4">web app</a
						>
						on GitHub.
					</p>
				</div>

				<div class="mt-10 grid gap-6 sm:grid-cols-2">
					{#each differentiators as item (item.title)}
						<article
							class="rounded-2xl border border-border bg-background p-6 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md"
						>
							<div
								class="flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-muted text-foreground"
							>
								<item.icon class="h-5 w-5" />
							</div>
							<h3 class="text-lg font-medium tracking-tight">{item.title}</h3>
							<p class="mt-3 text-sm leading-7 text-muted-foreground">{item.body}</p>
						</article>
					{/each}
				</div>
			</div>
		</section>
	</main>
</div>
