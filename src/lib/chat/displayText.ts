/**
 * Shared text hygiene for kind payloads whose fields render as display text
 * (poll questions/options, calendar titles/locations). One copy, because a
 * second kind accepting text is not a reason for a second rule.
 */

const CONTROL_RANGES: Array<[number, number]> = [
	[0x00, 0x1f],
	[0x7f, 0x9f]
];
const BIDI_CHARS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

export function utf8ByteLength(value: string): number {
	return new TextEncoder().encode(value).length;
}

export function hasControlChars(value: string): boolean {
	return [...value].some((char) => {
		const code = char.codePointAt(0) ?? 0;
		return CONTROL_RANGES.some(([low, high]) => code >= low && code <= high);
	});
}

/** Display text must be trimmed, non-empty, within `maxBytes` when a cap is
 *  given, and free of control / bidirectional override characters (display
 *  text is a spoofing surface). */
export function isSafeDisplayText(value: string, maxBytes = Number.POSITIVE_INFINITY): boolean {
	return (
		value.length > 0 &&
		value.trim() === value &&
		utf8ByteLength(value) <= maxBytes &&
		!hasControlChars(value) &&
		!BIDI_CHARS.test(value)
	);
}
