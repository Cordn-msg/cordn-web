/**
 * Minimal, dependency-free Markdown parser that returns a typed node tree
 * (never HTML strings). Rendering happens through component trees whose text
 * nodes auto-escape, so the output is safe for UNTRUSTED input by
 * construction — chat messages and in-repo content (news, why page) share it.
 *
 * Supported subset (deliberately small, WhatsApp/Discord-grade — not
 * CommonMark-conformant):
 * - blocks: headings (1–3), paragraphs, unordered/ordered lists, fenced code
 *   blocks (```), blockquotes (`>`), blank-line block breaks
 * - inline: `**strong**`, `*em*`/`_em_` (word-boundary), `~~del~~`,
 *   `` `code spans` `` (no nesting inside), `[text](href)` with scheme
 *   validation (http/https/relative only — anything else stays literal text),
 *   backslash escapes, single newlines preserved as `softbreak` nodes
 *   (renderers decide: space for prose, <br> for chat)
 *
 * Known ceilings (fine for chat; revisit if LLM-style documents ever matter):
 * `***bold-italic***` nests one level only; nested lists/quotes flatten;
 * link text is flattened to plain text; emphasis pairing is greedy
 * nearest-match, not CommonMark's flanking algorithm.
 */

export type MarkdownInlineNode =
	| { type: 'text'; text: string }
	| { type: 'code'; text: string }
	| { type: 'strong'; children: MarkdownInlineNode[] }
	| { type: 'em'; children: MarkdownInlineNode[] }
	| { type: 'del'; children: MarkdownInlineNode[] }
	| { type: 'link'; text: string; href: string }
	| { type: 'softbreak' };

export type MarkdownBlock =
	| { type: 'heading'; level: 1 | 2 | 3; inline: MarkdownInlineNode[] }
	| { type: 'paragraph'; inline: MarkdownInlineNode[] }
	| { type: 'list'; ordered: boolean; items: MarkdownInlineNode[][] }
	| { type: 'code'; text: string; lang?: string }
	| { type: 'quote'; inline: MarkdownInlineNode[] };

// ---------------------------------------------------------------------------
// Inline pass
// ---------------------------------------------------------------------------

const isAlnum = (c: string | undefined): boolean => Boolean(c && /[a-z0-9]/i.test(c));

function isValidHref(href: string): boolean {
	// http(s)/app-relative only: openMessageLink's native tail (Custom Tab) has
	// no sensible handling for mailto: and friends — those render as text.
	return /^(https?:\/\/|\/|#)/i.test(href);
}

/** Tokenizer output for one inline segment. */
type InlineTok =
	| { k: 't'; s: string }
	| { k: 'code'; s: string }
	| { k: 'br' }
	| { k: 'd'; s: '**' | '*' | '_' | '~~'; canOpen: boolean; canClose: boolean }
	| { k: 'ob' }
	| { k: 'cb'; href: string; raw: string };

function tokenizeInline(src: string): InlineTok[] {
	const toks: InlineTok[] = [];
	let text = '';
	const flushText = () => {
		if (text) toks.push({ k: 't', s: text });
		text = '';
	};

	let i = 0;
	while (i < src.length) {
		const c = src[i];

		if (c === '\\' && /[*_`~[\]\\]/.test(src[i + 1] ?? '')) {
			text += src[i + 1];
			i += 2;
			continue;
		}

		if (c === '`') {
			let open = i;
			while (src[open] === '`') open++;
			const run = src.slice(i, open);
			// Find a closing run of exactly the same length.
			let j = open;
			let close = -1;
			while (j < src.length) {
				if (src[j] === '`') {
					let k = j;
					while (src[k] === '`') k++;
					if (k - j === run.length) {
						close = j;
						break;
					}
					j = k;
				} else {
					j++;
				}
			}
			if (close === -1) {
				text += run;
				i = open;
			} else {
				let body = src.slice(open, close);
				// CommonMark-lite: strip one leading+trailing space when both exist.
				if (body.startsWith(' ') && body.endsWith(' ') && body.length > 2) {
					body = body.slice(1, -1);
				}
				flushText();
				toks.push({ k: 'code', s: body });
				i = close + run.length;
			}
			continue;
		}

		if (c === '\n') {
			flushText();
			toks.push({ k: 'br' });
			i++;
			continue;
		}

		if (c === '*' || c === '_' || (c === '~' && src[i + 1] === '~')) {
			const marker = c === '~' ? '~~' : c === '*' && src[i + 1] === '*' ? '**' : (c as '*' | '_');
			const start = i;
			i += marker.length;
			// CommonMark-lite flanking: openers are followed by non-space, closers
			// preceded by non-space — so `2 * 3 * 4` stays literal. `_` additionally
			// requires word boundaries so snake_case_name never italicizes.
			const next = src[i];
			const prev = src[start - 1];
			const canOpen = next !== undefined && !/\s/.test(next) && (marker !== '_' || !isAlnum(prev));
			const canClose = prev !== undefined && !/\s/.test(prev) && (marker !== '_' || !isAlnum(next));
			flushText();
			toks.push({ k: 'd', s: marker, canOpen, canClose });
			continue;
		}

		if (c === '[') {
			flushText();
			toks.push({ k: 'ob' });
			i++;
			continue;
		}

		if (c === ']') {
			const after = src.slice(i + 1);
			const m = /^\(([^()\s]*)\)/.exec(after);
			if (m && isValidHref(m[1])) {
				flushText();
				toks.push({ k: 'cb', href: m[1], raw: `](${m[1]})` });
				i += 1 + m[0].length;
				continue;
			}
			text += c;
			i++;
			continue;
		}

		text += c;
		i++;
	}
	flushText();
	return toks;
}

function mergeAdjacentText(nodes: MarkdownInlineNode[]): MarkdownInlineNode[] {
	const merged: MarkdownInlineNode[] = [];
	for (const node of nodes) {
		const last = merged[merged.length - 1];
		if (node.type === 'text' && last?.type === 'text') last.text += node.text;
		else merged.push(node);
	}
	return merged;
}

function flattenText(nodes: MarkdownInlineNode[]): string {
	return nodes
		.map((n) => {
			switch (n.type) {
				case 'text':
				case 'code':
					return n.text;
				case 'strong':
				case 'em':
				case 'del':
					return flattenText(n.children);
				case 'softbreak':
					return ' ';
				case 'link':
					return n.text;
			}
		})
		.join('');
}

/**
 * Greedy nearest-pair emphasis/link matching over the token stream. Openers
 * push a literal-fallback text node into `out` and remember its index; a
 * closer splices from there, shifts the fallback off, and wraps the rest.
 * Unclosed openers therefore degrade to literal text with zero extra work.
 */
function parseInline(src: string): MarkdownInlineNode[] {
	const toks = tokenizeInline(src);
	const out: MarkdownInlineNode[] = [];
	const open: Array<{ marker: string; nodeIndex: number }> = [];

	for (const tok of toks) {
		if (tok.k === 't' || tok.k === 'code' || tok.k === 'br') {
			out.push(
				tok.k === 't'
					? { type: 'text', text: tok.s }
					: tok.k === 'code'
						? { type: 'code', text: tok.s }
						: { type: 'softbreak' }
			);
		} else if (tok.k === 'ob') {
			out.push({ type: 'text', text: '[' }); // literal fallback
			open.push({ marker: '[', nodeIndex: out.length - 1 });
		} else if (tok.k === 'cb') {
			const idx = open.map((o) => o.marker).lastIndexOf('[');
			if (idx === -1) {
				out.push({ type: 'text', text: tok.raw });
				continue;
			}
			const opener = open[idx];
			open.length = idx;
			const children = out.splice(opener.nodeIndex);
			children.shift(); // drop the literal '[' fallback
			out.push({ type: 'link', text: flattenText(children), href: tok.href });
		} else if (tok.k === 'd') {
			const idx = tok.canClose ? open.map((o) => o.marker).lastIndexOf(tok.s) : -1;
			if (idx === -1) {
				out.push({ type: 'text', text: tok.s }); // inert or literal fallback
				if (tok.canOpen) open.push({ marker: tok.s, nodeIndex: out.length - 1 });
			} else {
				const opener = open[idx];
				open.length = idx;
				const children = out.splice(opener.nodeIndex);
				children.shift(); // drop the literal delimiter fallback
				const merged = mergeAdjacentText(children);
				out.push(
					tok.s === '**'
						? { type: 'strong', children: merged }
						: tok.s === '~~'
							? { type: 'del', children: merged }
							: { type: 'em', children: merged }
				);
			}
		}
	}

	return mergeAdjacentText(out);
}

// ---------------------------------------------------------------------------
// Block pass
// ---------------------------------------------------------------------------

const HEADING_RE = /^(#{1,3})\s+(.*)$/;
const UL_RE = /^[-*]\s+(.*)$/;
const OL_RE = /^\d+\.\s+(.*)$/;
const FENCE_RE = /^```\s*(\S*)\s*$/;

export function parseMarkdown(source: string): MarkdownBlock[] {
	const lines = source.replace(/\r\n?/g, '\n').split('\n');
	const blocks: MarkdownBlock[] = [];
	let paragraph: string[] = [];
	let listItems: string[] = [];
	let listOrdered = false;
	let quote: string[] = [];

	const flushParagraph = () => {
		if (!paragraph.length) return;
		blocks.push({ type: 'paragraph', inline: parseInline(paragraph.join('\n')) });
		paragraph = [];
	};

	const flushList = () => {
		if (!listItems.length) return;
		blocks.push({
			type: 'list',
			ordered: listOrdered,
			items: listItems.map((item) => parseInline(item))
		});
		listItems = [];
	};

	const flushQuote = () => {
		if (!quote.length) return;
		blocks.push({ type: 'quote', inline: parseInline(quote.join('\n')) });
		quote = [];
	};

	const flushAll = () => {
		flushParagraph();
		flushList();
		flushQuote();
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		// Fenced code: toggles until a matching fence; content is raw.
		const fence = FENCE_RE.exec(line);
		if (fence) {
			flushAll();
			const lang = fence[1] || undefined;
			const body: string[] = [];
			i++;
			while (i < lines.length && !FENCE_RE.test(lines[i])) {
				body.push(lines[i]);
				i++;
			}
			blocks.push({ type: 'code', text: body.join('\n'), lang });
			continue;
		}

		const trimmed = line.trim();

		if (!trimmed) {
			flushAll();
			continue;
		}

		const heading = HEADING_RE.exec(trimmed);
		if (heading) {
			flushAll();
			blocks.push({
				type: 'heading',
				level: heading[1].length as 1 | 2 | 3,
				inline: parseInline(heading[2])
			});
			continue;
		}

		if (trimmed.startsWith('>')) {
			flushParagraph();
			flushList();
			quote.push(trimmed.replace(/^>\s?/, ''));
			continue;
		}

		const ul = UL_RE.exec(trimmed);
		if (ul) {
			flushParagraph();
			flushQuote();
			if (listItems.length && listOrdered) flushList();
			listOrdered = false;
			listItems.push(ul[1]);
			continue;
		}

		const ol = OL_RE.exec(trimmed);
		if (ol) {
			flushParagraph();
			flushQuote();
			if (listItems.length && !listOrdered) flushList();
			listOrdered = true;
			listItems.push(ol[1]);
			continue;
		}

		flushList();
		flushQuote();
		paragraph.push(trimmed);
	}

	flushAll();
	return blocks;
}

/**
 * Cheap pre-check: does this text contain any character that could start a
 * markdown construct? Plain chat messages skip parsing entirely and render
 * through the existing mention/link pipeline at today's cost.
 */
export function mayContainMarkdown(text: string): boolean {
	// `#`/`>` only matter at line start (headings, quotes) so URL fragments and
	// comparison prose don't trigger a parse; `*_`~[` and `[` anywhere do.
	return /[*_`~[]/.test(text) || /^\s*(#|>|-\s|\d+\.\s|```)/m.test(text);
}
