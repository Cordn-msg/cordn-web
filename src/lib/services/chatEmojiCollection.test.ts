import { describe, expect, it } from 'vitest';

import { collectionName } from './chatEmojiCollection.svelte';

describe('collected emoji names', () => {
	it('keeps a legal name and sanitizes what is not', () => {
		expect(collectionName('party-cat_2.gif', new Set())).toBe('party-cat_2');
		expect(collectionName('my cat photo.png', new Set())).toBe('my_cat_photo');
		expect(collectionName('  ', new Set())).toBe('emoji');
	});

	it('counts every suffix the collection can hold', () => {
		// The collection caps at 100 items, so name #100 must still be unique.
		const taken = new Set(['cat', ...Array.from({ length: 98 }, (_, i) => `cat_${i + 2}`)]);
		expect(collectionName('cat', taken)).toBe('cat_100');
	});
});
