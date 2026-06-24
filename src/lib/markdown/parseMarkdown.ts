/**
 * Minimal, dependency-free Markdown parser for trusted in-repo content.
 *
 * Supports headings (1–3), paragraphs, and unordered lists, with inline
 * `` `code` ``, `**bold**`, and `[link](url)`. Output is intended to be rendered
 * with `{@html}` inside a `prose` container.
 *
 * NOTE: this does no HTML escaping. Only use it for content authored inside this
 * repository — never feed untrusted/remote text through it.
 */

export type MarkdownBlock =
	| { type: 'heading'; level: 1 | 2 | 3; text: string }
	| { type: 'paragraph'; text: string }
	| { type: 'list'; items: string[] };

export function inlineMarkdown(text: string): string {
	return text
		.replace(/`([^`]+)`/g, '<code>$1</code>')
		.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
		.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

export function parseMarkdown(source: string): MarkdownBlock[] {
	const lines = source.split('\n');
	const blocks: MarkdownBlock[] = [];
	let paragraph: string[] = [];
	let listItems: string[] = [];

	const flushParagraph = () => {
		if (!paragraph.length) return;
		blocks.push({ type: 'paragraph', text: inlineMarkdown(paragraph.join(' ')) });
		paragraph = [];
	};

	const flushList = () => {
		if (!listItems.length) return;
		blocks.push({ type: 'list', items: listItems.map((item) => inlineMarkdown(item)) });
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
