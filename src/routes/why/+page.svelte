<script lang="ts">
	import { resolve } from '$app/paths';
	import markdownSource from '../../../docs/why-cordn.md?raw';

	type Block =
		| { type: 'heading'; level: 1 | 2 | 3; text: string }
		| { type: 'paragraph'; text: string }
		| { type: 'list'; items: string[] };

	function inlineMarkdown(text: string): string {
		return text
			.replace(/`([^`]+)`/g, '<code>$1</code>')
			.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
			.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
	}

	function parseMarkdown(source: string): Block[] {
		const lines = source.split('\n');
		const blocks: Block[] = [];
		let paragraph: string[] = [];
		let listItems: string[] = [];

		const flushParagraph = () => {
			if (!paragraph.length) return;
			blocks.push({
				type: 'paragraph',
				text: inlineMarkdown(paragraph.join(' '))
			});
			paragraph = [];
		};

		const flushList = () => {
			if (!listItems.length) return;
			blocks.push({
				type: 'list',
				items: listItems.map((item) => inlineMarkdown(item))
			});
			listItems = [];
		};

		for (const rawLine of lines) {
			const line = rawLine.trim();

			if (!line) {
				flushParagraph();
				flushList();
				continue;
			}

			const headingMatch = line.match(/^(#{1,3})\s+(.*)$/);
			if (headingMatch) {
				flushParagraph();
				flushList();
				blocks.push({
					type: 'heading',
					level: headingMatch[1].length as 1 | 2 | 3,
					text: inlineMarkdown(headingMatch[2])
				});
				continue;
			}

			if (line.startsWith('- ')) {
				flushParagraph();
				listItems.push(line.slice(2));
				continue;
			}

			paragraph.push(line);
		}

		flushParagraph();
		flushList();
		return blocks;
	}

	const blocks = parseMarkdown(markdownSource);
</script>

<svelte:head>
	<title>Why Cordn</title>
	<meta
		name="description"
		content="Why Cordn exists, what tradeoffs it makes, and how it approaches private group messaging."
	/>
</svelte:head>

<div class="min-h-screen bg-background text-foreground">
	<div class="mx-auto max-w-4xl px-6 py-16">
		<div class="mb-8">
			<a
				href={resolve('/')}
				class="inline-flex items-center rounded-md border border-border bg-background px-4 py-2 text-sm font-medium transition-colors hover:bg-muted"
			>
				Back to home
			</a>
		</div>

		<div class="mb-10 space-y-4">
			<p class="text-sm font-medium tracking-[0.2em] text-muted-foreground uppercase">Why Cordn</p>
			<h1 class="text-4xl font-semibold tracking-tight md:text-5xl">Why Cordn exists.</h1>
			<p class="max-w-3xl text-lg leading-8 text-muted-foreground">
				An accessible explanation of the problem Cordn is solving, the tradeoffs it makes, and why
				private group messaging still needs clear coordination.
			</p>
		</div>

		<article class="prose max-w-none prose-neutral dark:prose-invert">
			{#each blocks as block}
				{#if block.type === 'heading'}
					{#if block.level === 1}
						<h1>{@html block.text}</h1>
					{:else if block.level === 2}
						<h2>{@html block.text}</h2>
					{:else}
						<h3>{@html block.text}</h3>
					{/if}
				{:else if block.type === 'paragraph'}
					<p>{@html block.text}</p>
				{:else}
					<ul>
						{#each block.items as item}
							<li>{@html item}</li>
						{/each}
					</ul>
				{/if}
			{/each}
		</article>
	</div>
</div>
