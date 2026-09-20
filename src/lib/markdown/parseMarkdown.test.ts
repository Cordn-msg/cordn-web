import { describe, expect, it } from 'vitest';

import { mayContainMarkdown, parseMarkdown } from './parseMarkdown';

type Block = ReturnType<typeof parseMarkdown>;

function single(src: string): Block[number] {
	const blocks = parseMarkdown(src);
	expect(blocks).toHaveLength(1);
	return blocks[0];
}

function inlineOf(src: string) {
	const block = single(src);
	if (block.type !== 'paragraph' && block.type !== 'heading') {
		throw new Error(`expected paragraph, got ${block.type}`);
	}
	return block.inline;
}

/** Deep-collect the tree as a readable form: text runs + wrapper names. */
function shape(nodes: unknown[]): string[] {
	return nodes.flatMap((n) => {
		const node = n as Record<string, unknown>;
		switch (node.type) {
			case 'text':
				return [`t:${node.text}`];
			case 'code':
				return [`c:${node.text}`];
			case 'softbreak':
				return ['br'];
			case 'link':
				return [`a:${node.text}:${node.href}`];
			default:
				return [`${node.type}(`, ...shape(node.children as unknown[]), ')'];
		}
	});
}

describe('parseMarkdown blocks', () => {
	it('wraps plain text in a paragraph', () => {
		expect(single('hello world').type).toBe('paragraph');
		expect(shape(inlineOf('hello world'))).toEqual(['t:hello world']);
	});

	it('splits paragraphs on blank lines and keeps single newlines as softbreaks', () => {
		const blocks = parseMarkdown('one\ntwo\n\nthree');
		expect(blocks).toHaveLength(2);
		expect(shape((blocks[0] as { inline: unknown[] }).inline)).toEqual(['t:one', 'br', 't:two']);
	});

	it('parses headings level 1–3 with inline content', () => {
		const h = single('# Title **bold**');
		expect(h.type).toBe('heading');
		if (h.type === 'heading') {
			expect(h.level).toBe(1);
			expect(shape(h.inline)).toEqual(['t:Title ', 'strong(', 't:bold', ')']);
		}
	});

	it('collects consecutive bullets into one list, ordered separately', () => {
		const blocks = parseMarkdown('- a\n- b\n\n1. x\n2. y');
		expect(blocks).toHaveLength(2);
		expect(blocks[0]).toMatchObject({ type: 'list', ordered: false });
		expect((blocks[0] as { items: unknown[][] }).items).toHaveLength(2);
		expect(blocks[1]).toMatchObject({ type: 'list', ordered: true });
	});

	it('captures fenced code verbatim with lang, no inline parsing inside', () => {
		const block = single('```ts\nconst a = *not emphasis*;\n```');
		expect(block).toEqual({ type: 'code', text: 'const a = *not emphasis*;', lang: 'ts' });
	});

	it('parses blockquotes with the marker stripped', () => {
		const q = single('> quoted **text**');
		expect(q.type).toBe('quote');
		if (q.type === 'quote') {
			expect(shape(q.inline)).toEqual(['t:quoted ', 'strong(', 't:text', ')']);
		}
	});
});

describe('parseMarkdown inline', () => {
	it('nests em inside strong', () => {
		expect(shape(inlineOf('**a *b* c**'))).toEqual([
			'strong(',
			't:a ',
			'em(',
			't:b',
			')',
			't: c',
			')'
		]);
	});

	it('renders unmatched delimiters literally', () => {
		expect(shape(inlineOf('a * b'))).toEqual(['t:a * b']);
		expect(shape(inlineOf('**bold'))).toEqual(['t:**bold']);
	});

	it('code spans win over emphasis and keep content literal', () => {
		expect(shape(inlineOf('see `*not em*` now'))).toEqual(['t:see ', 'c:*not em*', 't: now']);
	});

	it('pairs backtick runs of equal length only', () => {
		expect(shape(inlineOf('``a ` b`` and `c `` d`'))).toEqual(['c:a ` b', 't: and ', 'c:c `` d']);
	});

	it('strips one space padding inside code spans', () => {
		expect(shape(inlineOf('` x `'))).toEqual(['c:x']);
	});

	it('strikes through with ~~', () => {
		expect(shape(inlineOf('~~gone~~'))).toEqual(['del(', 't:gone', ')']);
	});

	it('does not emphasize intraword or spaced asterisks', () => {
		expect(shape(inlineOf('2 * 3 * 4'))).toEqual(['t:2 * 3 * 4']);
		expect(shape(inlineOf('snake_case_name'))).toEqual(['t:snake_case_name']);
	});

	it('emphasizes _em_ at word boundaries', () => {
		expect(shape(inlineOf('a _really_ nice'))).toEqual(['t:a ', 'em(', 't:really', ')', 't: nice']);
	});

	it('builds links and flattens formatted link text', () => {
		expect(shape(inlineOf('go [to **the** docs](https://x.dev/a) now'))).toEqual([
			't:go ',
			'a:to the docs:https://x.dev/a',
			't: now'
		]);
	});

	it('keeps non-http schemes as literal text', () => {
		expect(shape(inlineOf('click [here](javascript:alert(1))'))).toEqual([
			't:click [here](javascript:alert(1))'
		]);
	});

	it('keeps unmatched brackets literal', () => {
		expect(shape(inlineOf('array[0] is fine'))).toEqual(['t:array[0] is fine']);
	});

	it('resolves backslash escapes', () => {
		expect(shape(inlineOf('\\*not em\\* and \\`code\\`'))).toEqual(['t:*not em* and `code`']);
	});

	it('softbreaks inside paragraphs become br nodes', () => {
		expect(shape(inlineOf('line one\nline two'))).toEqual(['t:line one', 'br', 't:line two']);
	});
});

describe('parseMarkdown safety', () => {
	it('never emits HTML nodes — raw script tags survive as plain text', () => {
		const inline = inlineOf('<script>alert(1)</script>');
		expect(shape(inline)).toEqual(['t:<script>alert(1)</script>']);
		// The VM only ever carries typed nodes; text rendering escapes downstream.
		const types = new Set(JSON.stringify(inline).match(/"type":"([a-z]+)"/g));
		expect(types.has('"type":"html"')).toBe(false);
	});

	it('drops data: urls from links', () => {
		expect(shape(inlineOf('[x](data:text/html,hi)'))).toEqual(['t:[x](data:text/html,hi)']);
	});
});

describe('mayContainMarkdown', () => {
	it('is false for plain chat text including bare urls', () => {
		expect(mayContainMarkdown('hello there friend')).toBe(false);
		expect(mayContainMarkdown('see https://example.com/a?b=c#d ok')).toBe(false);
		expect(mayContainMarkdown('npub1abc def123')).toBe(false);
	});

	it('is true when a trigger char is present', () => {
		expect(mayContainMarkdown('**bold**')).toBe(true);
		expect(mayContainMarkdown('# heading')).toBe(true);
		expect(mayContainMarkdown('> quote')).toBe(true);
		expect(mayContainMarkdown('a ` b')).toBe(true);
		expect(mayContainMarkdown('[x](https://a)')).toBe(true);
	});
});
