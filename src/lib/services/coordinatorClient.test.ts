import { afterEach, describe, expect, test, vi } from 'vitest';
import {
	ApplesauceRelayPool,
	buildOpenStreamStartFrame,
	buildOpenStreamChunkFrame,
	CTXVM_MESSAGES_KIND,
	decryptMessage,
	PrivateKeySigner,
	type NostrSigner,
	type RelayHandler
} from '@contextvm/sdk';
import { ExtensionSigner } from 'applesauce-signers/signers';
import type { NostrEvent } from 'nostr-tools';
import { cordnClient } from './coordinatorClient';

vi.mock('$lib/services/relay-pool', () => ({ defaultRelays: ['wss://offline.invalid'] }));

const server = new PrivateKeySigner('01'.repeat(32));
const serverPubkey = await server.getPublicKey();
type Request = { event: NostrEvent; id: number; name: string; token: string };

/** Real SDK signing/correlation/stream handling, with only relay I/O replaced. */
class OfflineRelay implements RelayHandler {
	requests: Request[] = [];
	listeners = new Set<(event: NostrEvent) => void>();
	pendingPublishes = new Set<(error: Error) => void>();
	stallPublish = false;
	connect = vi.fn(async () => {});
	disconnect = vi.fn(async () => {
		for (const reject of this.pendingPublishes) reject(new Error('Publish aborted'));
		this.pendingPublishes.clear();
		this.listeners.clear();
	});
	getRelayUrls() {
		return ['wss://offline.invalid'];
	}
	unsubscribe() {
		this.listeners.clear();
	}
	async subscribe(_filters: unknown, onEvent: (event: NostrEvent) => void) {
		this.listeners.add(onEvent);
		return () => {
			this.listeners.delete(onEvent);
		};
	}
	async publish(event: NostrEvent) {
		const inner = JSON.parse(await decryptMessage(event, server)) as NostrEvent;
		const rpc = JSON.parse(inner.content);
		if (rpc.method === 'tools/call') {
			this.requests.push({
				event: inner,
				id: rpc.id,
				name: rpc.params.name,
				token: String(rpc.params._meta.progressToken)
			});
		}
		if (this.stallPublish)
			await new Promise<never>((_, reject) => {
				this.pendingPublishes.add(reject);
			});
	}
	async deliver(request: Request, message: object) {
		const event = await server.signEvent({
			pubkey: serverPubkey,
			kind: CTXVM_MESSAGES_KIND,
			created_at: Math.floor(Date.now() / 1000),
			tags: [
				['e', request.event.id],
				['p', request.event.pubkey]
			],
			content: JSON.stringify({ jsonrpc: '2.0', ...message })
		});
		for (const listener of this.listeners) listener(event);
	}
	async result(request: Request, structuredContent: object) {
		await this.deliver(request, { id: request.id, result: { content: [], structuredContent } });
	}
	async progress(request: Request, params: object) {
		await this.deliver(request, { method: 'notifications/progress', params });
	}
}

const clients: cordnClient[] = [];
function client(relay = new OfflineRelay(), signer?: NostrSigner) {
	const instance = new cordnClient({ serverPubkey, relayHandler: relay, signer });
	clients.push(instance);
	return { instance, relay };
}

async function requestAt(relay: OfflineRelay, index = 0): Promise<Request> {
	await vi.waitFor(() => expect(relay.requests.length).toBeGreaterThan(index));
	return relay.requests[index];
}

afterEach(async () => {
	await Promise.all(clients.splice(0).map((instance) => instance.disconnect()));
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe('coordinator client lifetime', () => {
	test('stable-lane calls fail fast when the signer lacks NIP-44 v2', async () => {
		// A real signer with nip44 stripped — the extension-without-nip44 case.
		// Without the guard, every gift-wrapped response is undecryptable and each
		// stable call hangs to the 20s timeout blaming the network.
		const signer = new PrivateKeySigner('02'.repeat(32));
		(signer as { nip44?: unknown }).nip44 = undefined;
		const { instance, relay } = client(new OfflineRelay(), signer);

		await expect(instance.FetchPendingWelcomes({})).rejects.toThrow(/NIP-44 v2/);
		expect(relay.requests).toHaveLength(0); // no I/O, no 20s hang

		// The guard must not over-block: the ephemeral lane signs with its own
		// local key, so it still reaches the relay without the user signer's nip44.
		const subscription = instance.SubscribeManyGroupMessages({ groups: [{ gid: 'g' }] });
		void subscription.catch(() => undefined);
		await requestAt(relay);
	});

	test('stable calls pick up NIP-44 support the signer reports late', async () => {
		// Extensions inject window.nostr asynchronously: capability observed at
		// client construction must not be frozen for the client's whole lifetime.
		const signer = new PrivateKeySigner('02'.repeat(32));
		const nip44 = signer.nip44;
		(signer as { nip44?: unknown }).nip44 = undefined;
		const { instance, relay } = client(new OfflineRelay(), signer);
		(signer as { nip44?: unknown }).nip44 = nip44;

		const pending = expect(instance.FetchPendingWelcomes({})).resolves.toEqual({ welcomes: [] });
		await relay.result(await requestAt(relay), { welcomes: [] });
		await pending;
	});

	test('an un-injected extension fails as signer-missing, not NIP-44', async () => {
		// Not ready ≠ incapable: the message must route into the signer-ready
		// retry ladder instead of claiming the signer lacks NIP-44 v2.
		vi.stubGlobal('window', {}); // window.nostr not injected yet
		const { instance, relay } = client(new OfflineRelay(), new ExtensionSigner());
		await expect(instance.FetchPendingWelcomes({})).rejects.toThrow(/signer extension missing/i);
		expect(relay.requests).toHaveLength(0); // still fails fast, no I/O
	});

	test('an injected extension without nip44 gets the capability message', async () => {
		vi.stubGlobal('window', { nostr: {} });
		const { instance } = client(new OfflineRelay(), new ExtensionSigner());
		await expect(instance.FetchPendingWelcomes({})).rejects.toThrow(/NIP-44 v2/);
	});

	test('default clients own different pools even for the same relay set', async () => {
		// Relay objects are lazy; suppress subscription/publication so no websocket is opened.
		vi.spyOn(ApplesauceRelayPool.prototype, 'subscribe').mockResolvedValue(() => {});
		vi.spyOn(ApplesauceRelayPool.prototype, 'publish').mockResolvedValue();
		const connect = vi.spyOn(ApplesauceRelayPool.prototype, 'connect');
		// Relay-less ("default") clients now enter the transport's resolution
		// chain; discoveryRelayUrls: [] pins it to the plain fallback path so
		// exactly one pool connect happens per client and the ownership
		// assertion below stays deterministic.
		const first = new cordnClient({ serverPubkey, discoveryRelayUrls: [] });
		const second = new cordnClient({ serverPubkey, discoveryRelayUrls: [] });
		clients.push(first, second);
		await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
		expect(connect.mock.contexts[0]).not.toBe(connect.mock.contexts[1]);
		await first.disconnect();
		expect(second.isClosed).toBe(false);
	});

	test('relay-less clients report the resolved relay set once (onRelaysResolved / operationalRelayUrls)', async () => {
		// Relay I/O replaced: with no discovery relays the resolution chain
		// short-circuits to the fallbackOperationalRelayUrls path (no probe), so
		// start() completes deterministically and the resolved set is the mocked
		// defaultRelays — exactly what persistence should record.
		vi.spyOn(ApplesauceRelayPool.prototype, 'subscribe').mockResolvedValue(() => {});
		vi.spyOn(ApplesauceRelayPool.prototype, 'publish').mockResolvedValue();
		vi.spyOn(ApplesauceRelayPool.prototype, 'connect').mockResolvedValue(undefined);
		const resolved: string[][] = [];
		const instance = new cordnClient({
			serverPubkey,
			discoveryRelayUrls: [],
			onRelaysResolved: (urls) => resolved.push(urls)
		});
		clients.push(instance);
		await vi.waitFor(() => expect(resolved).toEqual([['wss://offline.invalid']]));
		expect(await instance.operationalRelayUrls()).toEqual(['wss://offline.invalid']);
	});

	test('one hung publication does not block another RPC on the same transport', async () => {
		const { instance, relay } = client();
		relay.stallPublish = true;
		const first = instance.ListAvailableKeyPackages({});
		const failed = expect(first).rejects.toThrow('Connection closed');
		await requestAt(relay);
		const second = instance.FetchManyGroupMessages({ groups: [{ gid: 'group' }] });
		await relay.result(await requestAt(relay, 1), { messages: [] });
		await expect(second).resolves.toEqual({ messages: [] });
		await instance.disconnect();
		await failed;
		expect(relay.pendingPublishes.size).toBe(0);
	});

	test('a single timeout spares the owner; a second one retires it and its publisher', async () => {
		// Teardown is the only GC for the SDK's infinite publish retries, but one
		// slow RPC must not kill healthy group streams on the same transport — so
		// the owner is retired only on the second timeout (wedged transport).
		vi.useFakeTimers();
		const { instance, relay } = client();
		relay.stallPublish = true;
		const post = instance.PostGroupMessage({ gid: 'group', msg_64: 'cGF5bG9hZA==' });
		const failed = expect(post).rejects.toThrow(/timed out/);
		await requestAt(relay);
		await vi.advanceTimersByTimeAsync(8_000);
		await failed;
		expect(instance.isClosed).toBe(false);
		expect(relay.requests).toHaveLength(1); // the ambiguous call is never replayed
		// Strays stay retrying (the request + its SDK timeout-cancel notification)
		// and die with the next teardown — at most a handful per blip.
		expect(relay.pendingPublishes.size).toBe(2);
		const secondPost = instance.PostGroupMessage({ gid: 'group', msg_64: 'cGF5bG9hZA==' });
		const secondFailed = expect(secondPost).rejects.toThrow(/timed out/);
		await requestAt(relay, 1);
		await vi.advanceTimersByTimeAsync(8_000);
		await secondFailed;
		expect(instance.isClosed).toBe(true);
		expect(relay.pendingPublishes.size).toBe(0);
		expect(relay.requests).toHaveLength(2);
		await expect(instance.FetchPendingWelcomes({})).rejects.toThrow('Connection closed');
	});

	test('progress cannot extend a finite request beyond its absolute budget', async () => {
		vi.useFakeTimers();
		const { instance, relay } = client();
		const read = instance.ListAvailableKeyPackages({});
		const failed = expect(read).rejects.toThrow(/timed out/);
		const request = await requestAt(relay);
		await vi.advanceTimersByTimeAsync(10_000);
		await relay.progress(request, { progressToken: request.token, progress: 1 });
		await vi.advanceTimersByTimeAsync(10_000);
		await failed;
		// A single timeout no longer retires the owner (see the teardown-threshold test).
		expect(instance.isClosed).toBe(false);
	});

	test('disconnect during local setup prevents a late tool call', async () => {
		let release!: () => void;
		const { instance, relay } = client();
		// Start is already awaiting relay resolution, so this intercepts its connect.
		relay.connect.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				})
		);
		const read = instance.ListAvailableKeyPackages({});
		const failed = expect(read).rejects.toThrow('Connection closed');
		await vi.waitFor(() => expect(relay.connect).toHaveBeenCalled());
		await instance.disconnect();
		await failed;
		release();
		await vi.waitFor(() => expect(relay.disconnect).toHaveBeenCalledTimes(2));
		expect(relay.listeners.size).toBe(0);
		expect(relay.requests).toHaveLength(0);
	});

	test('signer work is tracked and late approval cannot publish through a retired client', async () => {
		const signer = new PrivateKeySigner('02'.repeat(32));
		const signEvent = signer.signEvent.bind(signer);
		let approve!: () => void;
		const approval = new Promise<void>((resolve) => {
			approve = resolve;
		});
		vi.spyOn(signer, 'signEvent').mockImplementation(async (event) => {
			await approval;
			return signEvent(event);
		});
		const { instance, relay } = client(new OfflineRelay(), signer);
		const pending = instance.FetchPendingWelcomes({});
		const failed = expect(pending).rejects.toThrow('Connection closed');
		await vi.waitFor(() => expect(signer.signEvent).toHaveBeenCalled());
		expect(instance.isSigning).toBe(true);
		await instance.disconnect();
		approve();
		await failed;
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(instance.isSigning).toBe(false);
		expect(relay.requests).toHaveLength(0);
	});
});

describe('stream readiness', () => {
	test('concurrent streams match start frames to their own progress tokens', async () => {
		const { instance, relay } = client();
		let firstReady = false;
		const first = instance
			.SubscribeManyGroupMessages({ groups: [{ gid: 'first' }] })
			.then((call) => {
				firstReady = true;
				return call;
			});
		const second = instance.SubscribeManyGroupMessages({ groups: [{ gid: 'second' }] });
		const firstRequest = await requestAt(relay);
		const secondRequest = await requestAt(relay, 1);
		await relay.progress(
			secondRequest,
			buildOpenStreamStartFrame({ progressToken: secondRequest.token, progress: 1 })
		);
		const secondCall = await second;
		expect(firstReady).toBe(false);
		await relay.progress(
			firstRequest,
			buildOpenStreamStartFrame({ progressToken: firstRequest.token, progress: 1 })
		);
		const firstCall = await first;
		expect(firstReady).toBe(true);
		await Promise.all([firstCall.abort('test'), secondCall.abort('test')]);
	});

	test('readiness requires a start frame, not a handle or final result', async () => {
		const { instance, relay } = client();
		let ready = false;
		const pending = instance
			.SubscribeManyGroupMessages({ groups: [{ gid: 'group' }] })
			.then((call) => {
				ready = true;
				return call;
			});
		const request = await requestAt(relay);
		expect(ready).toBe(false);
		await relay.progress(
			request,
			buildOpenStreamStartFrame({ progressToken: request.token, progress: 1 })
		);
		const call = await pending;
		expect(ready).toBe(true);
		let resultSettled = false;
		void call.result
			.then(() => {
				resultSettled = true;
			})
			.catch(() => undefined);
		const next = call.stream[Symbol.asyncIterator]().next();
		await relay.progress(
			request,
			buildOpenStreamChunkFrame({
				progressToken: request.token,
				progress: 2,
				chunkIndex: 0,
				data: JSON.stringify({ gid: 'group', cursor: 1, at: 1, msg_64: 'cGF5bG9hZA==' })
			})
		);
		await expect(next).resolves.toMatchObject({ value: { cursor: 1 }, done: false });
		expect(resultSettled).toBe(false);
		await call.abort('test complete');
	});

	test('a handle with no start frame expires at its deadline', async () => {
		vi.useFakeTimers();
		const { instance, relay } = client();
		relay.stallPublish = true;
		const pending = instance.SubscribeManyGroupMessages({ groups: [{ gid: 'group' }] });
		const failed = expect(pending).rejects.toThrow(/timed out/);
		await requestAt(relay);
		await vi.advanceTimersByTimeAsync(20_000);
		await failed;
		// First timeout is a blip (see the teardown-threshold test): the owner
		// survives and its stranded publish retry dies with the next teardown.
		expect(instance.isClosed).toBe(false);
		expect(relay.pendingPublishes.size).toBe(1);
	});

	test('local stream abort does not await a stuck abort publication', async () => {
		const { instance, relay } = client();
		const pending = instance.SubscribeManyGroupMessages({ groups: [{ gid: 'group' }] });
		const request = await requestAt(relay);
		await relay.progress(
			request,
			buildOpenStreamStartFrame({ progressToken: request.token, progress: 1 })
		);
		const call = await pending;
		const next = call.stream[Symbol.asyncIterator]().next();
		const failed = expect(next).rejects.toThrow(/abort/i);
		relay.stallPublish = true;
		await expect(call.abort('test')).resolves.toBeUndefined();
		await failed;
	});
});
