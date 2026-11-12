import { describe, expect, test } from 'vitest';
import { isRelayUrlReachable } from './relayUrl';

describe('isRelayUrlReachable', () => {
	test('wss works everywhere', () => {
		expect(isRelayUrlReachable('wss://relay.example', 'https:')).toBe(true);
		expect(isRelayUrlReachable('wss://relay.example', 'http:')).toBe(true);
	});

	test('ws on an https page is only reachable on loopback', () => {
		expect(isRelayUrlReachable('ws://newlay:7777', 'https:')).toBe(false);
		expect(isRelayUrlReachable('ws://192.168.1.10:7777', 'https:')).toBe(false);
		expect(isRelayUrlReachable('ws://localhost:7777', 'https:')).toBe(true);
		expect(isRelayUrlReachable('ws://relay.localhost:7777', 'https:')).toBe(true);
		expect(isRelayUrlReachable('ws://127.0.0.1:2147', 'https:')).toBe(true);
		expect(isRelayUrlReachable('ws://[::1]:2147', 'https:')).toBe(true);
	});

	test('ws on an http page stays reachable (local dev, LAN coordinators)', () => {
		expect(isRelayUrlReachable('ws://newlay:7777', 'http:')).toBe(true);
		expect(isRelayUrlReachable('ws://127.0.0.1:2147', 'http:')).toBe(true);
	});

	test('a malformed ws url is left to the connection layer', () => {
		expect(isRelayUrlReachable('ws://', 'https:')).toBe(true);
	});
});
