import { describe, it, expect } from 'vitest';
import {
	buildImetaTag,
	parseImetaTag,
	type MediaReference
} from '$lib/services/chatMediaCipher';

const BASE: MediaReference = {
	url: 'https://store.example/abc',
	mime: 'audio/webm',
	filename: 'voice-1.webm',
	plaintextHashHex: 'a'.repeat(64),
	nonceHex: 'b'.repeat(24),
	version: 'cordn-em-v1'
};

describe('imeta voice-note hints', () => {
	it('round-trips duration and waveform peaks', () => {
		const ref: MediaReference = {
			...BASE,
			durationMs: 12345,
			waveform: [0, 0.5, 1, 0.123, 0.987]
		};
		const parsed = parseImetaTag(buildImetaTag(ref));
		expect(parsed).not.toBeNull();
		expect(parsed!.durationMs).toBe(12345);
		// values survive 3-decimal rounding
		expect(parsed!.waveform).toEqual([0, 0.5, 1, 0.123, 0.987]);
	});

	it('omits the hint fields entirely when absent', () => {
		const parsed = parseImetaTag(buildImetaTag(BASE));
		expect(parsed).not.toBeNull();
		expect(parsed!.durationMs).toBeUndefined();
		expect(parsed!.waveform).toBeUndefined();
	});

	it('drops malformed waveform entries instead of breaking the render', () => {
		const tag = [
			'imeta',
			`url ${BASE.url}`,
			`m ${BASE.mime}`,
			`filename ${BASE.filename}`,
			`x ${BASE.plaintextHashHex}`,
			`n ${BASE.nonceHex}`,
			`v ${BASE.version}`,
			// out-of-range + non-numeric entries mixed with valid ones
			'waveform 0.2,NaN,1.5,bad,-0.1,0.4'
		];
		const parsed = parseImetaTag(tag);
		expect(parsed).not.toBeNull();
		expect(parsed!.waveform).toEqual([0.2, 0.4]);
	});

	it('treats duration/waveform as display hints (not required fields)', () => {
		// A tag carrying only duration, no waveform, must still parse.
		const tag = [
			'imeta',
			`url ${BASE.url}`,
			`m ${BASE.mime}`,
			`filename ${BASE.filename}`,
			`x ${BASE.plaintextHashHex}`,
			`n ${BASE.nonceHex}`,
			`v ${BASE.version}`,
			'duration 999'
		];
		const parsed = parseImetaTag(tag);
		expect(parsed!.durationMs).toBe(999);
		expect(parsed!.waveform).toBeUndefined();
	});
});
