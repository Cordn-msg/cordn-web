import { Client } from '@contextvm/mcp-sdk/client';
import type { CallToolResult } from '@contextvm/mcp-sdk/types.js';
import {
	callToolStream,
	NostrClientTransport,
	type NostrTransportOptions,
	PrivateKeySigner,
	ApplesauceRelayPool,
	GiftWrapMode
} from '@contextvm/sdk';
import type { ZodType } from 'zod';
import { defaultRelays } from './relay-pool';
import { errorMessage } from '$lib/utils';
import {
	type ConsumeKeyPackageInput,
	consumeKeyPackageOutputSchema,
	COORDINATOR_METHODS,
	type FetchManyGroupMessagesInput,
	fetchManyGroupMessagesOutputSchema,
	fetchPendingWelcomesOutputSchema,
	listAvailableKeyPackagesOutputSchema,
	type PostGroupMessageInput,
	postGroupMessageOutputSchema,
	type PublishKeyPackageInput,
	publishKeyPackageOutputSchema,
	storeWelcomeOutputSchema,
	subscribeManyGroupMessagesOutputSchema,
	type ConsumeKeyPackageOutput,
	type FetchManyGroupMessagesOutput,
	type FetchManyPendingJoinRequestsInput,
	type FetchManyPendingJoinRequestsOutput,
	fetchManyPendingJoinRequestsOutputSchema,
	type FetchPendingWelcomesInput,
	type FetchPendingWelcomesOutput,
	type GroupMessage,
	type ListAvailableKeyPackagesInput,
	type ListAvailableKeyPackagesOutput,
	type PostGroupMessageOutput,
	type PublishKeyPackageOutput,
	type RemoveKeyPackagesInput,
	type RemoveKeyPackagesOutput,
	type StoreJoinRequestInput,
	type StoreJoinRequestOutput,
	storeJoinRequestOutputSchema,
	type SubscribeManyGroupMessagesInput,
	type SubscribeManyGroupMessagesOutput,
	type StoreWelcomeInput,
	type StoreWelcomeOutput,
	groupMessageSchema,
	removeKeyPackagesOutputSchema
} from '../contracts/index.ts';

/**
 * Health signal emitted by `cordnClient` after every coordinator call. The
 * registry maps this onto the per-coordinator health store.
 */
export type CoordinatorHealthSignal = { status: 'healthy' } | { status: 'degraded'; error: string };

/**
 * Server-announced metadata learned from coordinator responses (CEP discovery
 * tags). All fields optional; present only once the server has replied.
 */
export type CoordinatorServerInfo = {
	name?: string;
	about?: string;
	website?: string;
	picture?: string;
};

export type coordinatorClient = {
	PublishKeyPackage: (input: PublishKeyPackageInput) => Promise<PublishKeyPackageOutput>;
	ListAvailableKeyPackages: (
		args: ListAvailableKeyPackagesInput
	) => Promise<ListAvailableKeyPackagesOutput>;
	ConsumeKeyPackage: (input: ConsumeKeyPackageInput) => Promise<ConsumeKeyPackageOutput>;
	RemoveKeyPackages: (input: RemoveKeyPackagesInput) => Promise<RemoveKeyPackagesOutput>;
	FetchPendingWelcomes: (args: FetchPendingWelcomesInput) => Promise<FetchPendingWelcomesOutput>;
	StoreWelcome: (input: StoreWelcomeInput) => Promise<StoreWelcomeOutput>;
	StoreJoinRequest: (input: StoreJoinRequestInput) => Promise<StoreJoinRequestOutput>;
	FetchManyPendingJoinRequests: (
		input: FetchManyPendingJoinRequestsInput
	) => Promise<FetchManyPendingJoinRequestsOutput>;
	PostGroupMessage: (input: PostGroupMessageInput) => Promise<PostGroupMessageOutput>;
	FetchManyGroupMessages: (
		input: FetchManyGroupMessagesInput,
		options?: { timeout?: number }
	) => Promise<FetchManyGroupMessagesOutput>;
	SubscribeManyGroupMessages: (input: SubscribeManyGroupMessagesInput) => Promise<{
		stream: AsyncIterable<GroupMessage>;
		result: Promise<SubscribeManyGroupMessagesOutput>;
		abort: (reason?: string) => Promise<void>;
		isStale: (marginMs?: number) => boolean;
	}>;
};

/**
 * Setup deadline for opening a subscription stream. `callToolStream` resolves
 * only once the subscribe request actually publishes, and a publish on a
 * wedged socket can retry forever. Bounding it here makes a stuck subscribe
 * fail fast as a transient error so the watch reconciler can rebuild.
 */
const SUBSCRIBE_SETUP_TIMEOUT_MS = 20_000;
/**
 * Deadline for the MCP initialize handshake (relay connect + round-trip).
 * Unbounded, it is capped only by the SDK's 60s request timeout — longer than
 * every deadline above it, which made tick deadlines detonate legitimately
 * slow cold starts. On timeout the client is disconnected; since SDK 0.13.11
 * that genuinely cancels the stuck initialize publish.
 */
const CONNECT_TIMEOUT_MS = 20_000;

async function callToolStreamWithSetupDeadline(params: Parameters<typeof callToolStream>) {
	const streamCall = callToolStream<CallToolResult>(...params);
	let setupTimer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			streamCall,
			new Promise<never>((_, reject) => {
				setupTimer = setTimeout(
					() =>
						reject(new Error(`Subscribe setup timed out after ${SUBSCRIBE_SETUP_TIMEOUT_MS}ms`)),
					SUBSCRIBE_SETUP_TIMEOUT_MS
				);
			})
		]);
	} catch (error) {
		// The losing promise may still resolve later; abort its stream so it
		// cannot leak as an orphaned subscription.
		void streamCall.then((call) => call.abort('setup timeout')).catch(() => undefined);
		throw error;
	} finally {
		if (setupTimer) clearTimeout(setupTimer);
	}
}

/**
 * Bounded MCP initialize handshake. The raw promise keeps only a logging
 * catch (its rejection is also observed by the race); on timeout we reject
 * and hand back control via `onTimeout` (the caller disconnects — with the
 * lifecycle pool that genuinely cancels the stuck initialize publish instead
 * of abandoning it as a zombie). `isClosed` downgrades the log for
 * rejections that are deliberate-teardown collateral, not failures.
 */
export async function withConnectDeadline(
	raw: Promise<void>,
	options: {
		kind: 'ephemeral' | 'stable';
		onTimeout: () => void;
		isClosed?: () => boolean;
	}
): Promise<void> {
	const { kind, onTimeout, isClosed } = options;
	void raw.catch((error) => {
		const log = isClosed?.() ? console.debug : console.error;
		log(`Failed to connect ${kind} client to server: ${error}`);
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			raw,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					reject(new Error(`${kind} connect timed out after ${CONNECT_TIMEOUT_MS}ms`));
					onTimeout();
				}, CONNECT_TIMEOUT_MS);
			})
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export class cordnClient implements coordinatorClient {
	private stableClient: Client | null = null;
	private stableTransport: NostrClientTransport | null = null;
	private stableConnected: Promise<void> | null = null;
	private readonly ephemeralClient: Client;
	private readonly ephemeralTransport: NostrClientTransport;
	private readonly ephemeralConnected: Promise<void>;
	private readonly onHealth?: (signal: CoordinatorHealthSignal) => void;
	private readonly onServerInfo?: (info: CoordinatorServerInfo) => void;
	/** Stored for lazy stable transport construction (see connectStable). */
	private readonly stableSigner: NostrTransportOptions['signer'];
	private readonly transportBase: Omit<NostrTransportOptions, 'signer'>;

	constructor(
		options: Partial<NostrTransportOptions> & {
			privateKey?: string;
			ephemeralPrivateKey?: string;
			relays?: string[];
			onHealth?: (signal: CoordinatorHealthSignal) => void;
			onServerInfo?: (info: CoordinatorServerInfo) => void;
		} = {}
	) {
		this.ephemeralClient = new Client({
			name: 'CvmMlsDeliveryServiceClientEphemeral',
			version: '1.0.0'
		});

		const resolvedPrivateKey = options.privateKey || '';
		const resolvedEphemeralPrivateKey = options.ephemeralPrivateKey;

		const relays = options.relays || [];
		// SDK ≥ 0.13.11: the pool cancels in-flight publish retries on disconnect.
		const relayHandler = new ApplesauceRelayPool(relays);
		const serverPubkey = options.serverPubkey;
		if (!serverPubkey) {
			throw new Error(
				'Missing coordinator server pubkey. Pass serverPubkey explicitly or configure the CLI entrypoint to provide one.'
			);
		}
		const { signer: providedSigner, onHealth, onServerInfo, ...rest } = options;
		this.onHealth = onHealth;
		this.onServerInfo = onServerInfo;
		delete (rest as Partial<typeof options>).privateKey;
		delete (rest as Partial<typeof options>).ephemeralPrivateKey;
		delete (rest as Partial<typeof options>).serverPubkey;
		delete (rest as Partial<typeof options>).relays;
		delete (rest as Partial<typeof options>).relayHandler;
		const ephemeralSigner = resolvedEphemeralPrivateKey
			? new PrivateKeySigner(resolvedEphemeralPrivateKey)
			: new PrivateKeySigner();

		// Shared transport config — stable and ephemeral differ only in signer.
		// Stored for lazy stable construction so read/receive-only sessions never
		// allocate the ~10 SDK helper objects the transport constructor creates.
		this.stableSigner = providedSigner || new PrivateKeySigner(resolvedPrivateKey);
		this.transportBase = {
			serverPubkey,
			relayHandler,
			fallbackOperationalRelayUrls: defaultRelays,
			logLevel: 'silent',
			isStateless: true,
			giftWrapMode: GiftWrapMode.EPHEMERAL,
			openStream: {
				enabled: true,
				policy: {
					// Keepalive: idle 30s → ping, pong due within 30s. Relays occasionally
					// eat a ping or pong; the default 20s probe window turned a single
					// lost round-trip into a stream abort + client swap. 30/30 keeps
					// dead-stream detection (60s) while tolerating one slow relay hop.
					idleTimeoutMs: 30_000,
					probeTimeoutMs: 30_000
				}
			},
			oversizedTransfer: {
				enabled: true
			},
			...rest
		};

		this.ephemeralTransport = new NostrClientTransport({
			...this.transportBase,
			signer: ephemeralSigner
		});

		this.ephemeralConnected = withConnectDeadline(
			this.ephemeralClient.connect(this.ephemeralTransport),
			{
				kind: 'ephemeral',
				onTimeout: () => void this.disconnect(),
				isClosed: () => this.closed
			}
		);
	}

	/** Set by {@link disconnect}: distinguishes deliberate teardown rejections
	 * (expected, debug) from genuine connect failures (error). */
	private closed = false;

	async disconnect(): Promise<void> {
		this.closed = true;
		// Never await the connect promises: a hung initialize on a dead socket
		// must not block teardown, and its eventual rejection is swallowed here.
		void this.stableConnected?.catch(() => undefined);
		void this.ephemeralConnected.catch(() => undefined);
		await Promise.all([
			this.stableTransport?.close().catch(() => undefined),
			this.ephemeralTransport.close().catch(() => undefined)
		]);
	}

	private connectStable(): Promise<void> {
		if (!this.stableConnected) {
			// Lazy-construct the stable transport + client on first stable call.
			// Most sessions are receive-only (ephemeral) and never need this.
			this.stableClient = new Client({
				name: 'CvmMlsDeliveryServiceClient',
				version: '1.0.0'
			});
			this.stableTransport = new NostrClientTransport({
				...this.transportBase,
				signer: this.stableSigner
			});
			this.stableConnected = withConnectDeadline(this.stableClient.connect(this.stableTransport), {
				kind: 'stable',
				onTimeout: () => void this.disconnect(),
				isClosed: () => this.closed
			});
		}

		return this.stableConnected;
	}

	private async call<T = unknown>(
		transportKind: 'stable' | 'ephemeral',
		name: string,
		args: Record<string, unknown>,
		schema?: ZodType<T>,
		options: { timeout?: number } = {}
	): Promise<T> {
		const connected = transportKind === 'stable' ? this.connectStable() : this.ephemeralConnected;

		try {
			await connected;
			const client = transportKind === 'stable' ? this.stableClient! : this.ephemeralClient;
			const result = await client.callTool(
				{
					name,
					arguments: { ...args }
				},
				undefined,
				{
					onprogress: () => undefined,
					resetTimeoutOnProgress: true,
					...(options.timeout !== undefined ? { timeout: options.timeout } : {})
				}
			);

			// Check if the server returned an error
			if (result.isError) {
				const content = result.content as Array<{ type: string; text?: string }> | undefined;
				const errorMessage =
					content
						?.filter((c) => c.type === 'text')
						.map((c) => c.text ?? '')
						.join('\n') || 'Unknown coordinator error';
				throw new Error(errorMessage);
			}

			const parsed = schema
				? schema.parse(result.structuredContent)
				: (result.structuredContent as T);
			this.onHealth?.({ status: 'healthy' });
			const serverInfo = this.getServerInfo();
			if (serverInfo.name || serverInfo.about || serverInfo.website || serverInfo.picture) {
				this.onServerInfo?.(serverInfo);
			}
			return parsed;
		} catch (error) {
			const detail = errorMessage(error);
			this.onHealth?.({ status: 'degraded', error: detail });
			throw error;
		}
	}

	/**
	 * Reads metadata tags from one transport's discovery store.
	 */
	private readTransportServerInfo(transport: NostrClientTransport | null): CoordinatorServerInfo {
		if (!transport) return {};
		const info: CoordinatorServerInfo = {};
		const name = transport.getServerInitializeName();
		const about = transport.getServerInitializeAbout();
		const website = transport.getServerInitializeWebsite();
		const picture = transport.getServerInitializePicture();
		if (name) info.name = name;
		if (about) info.about = about;
		if (website) info.website = website;
		if (picture) info.picture = picture;
		return info;
	}

	/**
	 * Merge server-announced metadata from both transports. The stable (write)
	 * and ephemeral (read) transports hold separate discovery stores; whichever
	 * responded first populates the gaps. No extra round-trip — this is whatever
	 * was already learned from routine coordinator calls.
	 */
	getServerInfo(): CoordinatorServerInfo {
		return {
			...this.readTransportServerInfo(this.stableTransport),
			...this.readTransportServerInfo(this.ephemeralTransport)
		};
	}

	/**
	 * Publish an MLS key package for the injected caller identity.
	 * @param {string} kp_ref The key package ref parameter
	 * @param {string} kp_64 The key package base64 parameter
	 * @returns {Promise<PublishKeyPackageOutput>} The result of the kp_publish operation
	 */
	async PublishKeyPackage(input: PublishKeyPackageInput): Promise<PublishKeyPackageOutput> {
		return this.call(
			'stable',
			COORDINATOR_METHODS.publishKeyPackage,
			input,
			publishKeyPackageOutputSchema
		);
	}

	/**
	 * Consume the next published MLS key package by stable identity or exact key package ref.
	 * @param {string} id The stable pubkey or key package ref parameter
	 * @returns {Promise<ConsumeKeyPackageOutput>} The result of the kp_take operation
	 */
	async ConsumeKeyPackage(input: ConsumeKeyPackageInput): Promise<ConsumeKeyPackageOutput> {
		return this.call(
			'ephemeral',
			COORDINATOR_METHODS.consumeKeyPackage,
			input,
			consumeKeyPackageOutputSchema
		);
	}

	async RemoveKeyPackages(input: RemoveKeyPackagesInput): Promise<RemoveKeyPackagesOutput> {
		return this.call(
			'stable',
			COORDINATOR_METHODS.removeKeyPackages,
			input,
			removeKeyPackagesOutputSchema
		);
	}

	/**
	 * List currently available published MLS key packages discoverable on the coordinator.
	 * @returns {Promise<ListAvailableKeyPackagesOutput>} The result of the kp_list operation
	 */
	async ListAvailableKeyPackages(
		args: ListAvailableKeyPackagesInput = {}
	): Promise<ListAvailableKeyPackagesOutput> {
		return this.call(
			'ephemeral',
			COORDINATOR_METHODS.listAvailableKeyPackages,
			args,
			listAvailableKeyPackagesOutputSchema
		);
	}

	/**
	 * Fetch and drain welcomes queued for the injected caller identity.
	 * @returns {Promise<FetchPendingWelcomesOutput>} The result of the welcome_take operation
	 */
	async FetchPendingWelcomes(args: FetchPendingWelcomesInput): Promise<FetchPendingWelcomesOutput> {
		return this.call(
			'stable',
			COORDINATOR_METHODS.fetchPendingWelcomes,
			args,
			fetchPendingWelcomesOutputSchema
		);
	}

	/**
	 * Store an MLS welcome for a target stable identity.
	 * @param {string} target_pk The target stable pubkey parameter
	 * @param {string} kp_ref The key package reference parameter
	 * @param {string} welcome_64 The welcome base64 parameter
	 * @returns {Promise<StoreWelcomeOutput>} The result of the welcome_store operation
	 */
	async StoreWelcome(input: StoreWelcomeInput): Promise<StoreWelcomeOutput> {
		return this.call(
			'ephemeral',
			COORDINATOR_METHODS.storeWelcome,
			input,
			storeWelcomeOutputSchema
		);
	}

	/**
	 * Store a join request for a group.
	 * @param {string} gid The group id parameter
	 * @param {string} kp_ref The key package reference parameter
	 * @returns {Promise<StoreJoinRequestOutput>} The result of the join_request_store operation
	 */
	async StoreJoinRequest(input: StoreJoinRequestInput): Promise<StoreJoinRequestOutput> {
		return this.call(
			'stable',
			COORDINATOR_METHODS.storeJoinRequest,
			input,
			storeJoinRequestOutputSchema
		);
	}

	/**
	 * Fetch pending join requests for multiple groups in a single batch call.
	 * @param groups The array of group input objects, each with a gid
	 * @returns {Promise<FetchManyPendingJoinRequestsOutput>} The result of the join_request_take_many operation
	 */
	async FetchManyPendingJoinRequests(
		input: FetchManyPendingJoinRequestsInput
	): Promise<FetchManyPendingJoinRequestsOutput> {
		return this.call(
			'ephemeral',
			COORDINATOR_METHODS.fetchManyPendingJoinRequests,
			input,
			fetchManyPendingJoinRequestsOutputSchema
		);
	}

	/**
	 * Queue an MLS opaque group message for the injected caller identity.
	 * @param {string} msg_64 The opaque message base64 parameter
	 * @returns {Promise<PostGroupMessageOutput>} The result of the msg_post operation
	 */
	async PostGroupMessage(input: PostGroupMessageInput): Promise<PostGroupMessageOutput> {
		return this.call(
			'ephemeral',
			COORDINATOR_METHODS.postGroupMessage,
			input,
			postGroupMessageOutputSchema,
			// ponytail: explicit 8s beats the MCP 60s default. On mobile
			// background-return a dead socket otherwise hangs the optimistic
			// "Sending…" state for a full minute before the transient-retry +
			// client-rebuild in withCoordinatorClient gets a chance to recover
			// it. 8s is generous for a coordinator queue op (ms steady-state);
			// only a stuck socket hits it, which is exactly when we bail+retry.
			{ timeout: 8_000 }
		);
	}

	async FetchManyGroupMessages(
		input: FetchManyGroupMessagesInput,
		options: { timeout?: number } = {}
	): Promise<FetchManyGroupMessagesOutput> {
		return this.call(
			'ephemeral',
			COORDINATOR_METHODS.fetchManyGroupMessages,
			input,
			fetchManyGroupMessagesOutputSchema,
			options
		);
	}

	async SubscribeManyGroupMessages(input: SubscribeManyGroupMessagesInput): Promise<{
		stream: AsyncIterable<GroupMessage>;
		result: Promise<SubscribeManyGroupMessagesOutput>;
		abort: (reason?: string) => Promise<void>;
		isStale: (marginMs?: number) => boolean;
	}> {
		await this.ephemeralConnected;

		const call = await callToolStreamWithSetupDeadline([
			{
				client: this.ephemeralClient,
				transport: this.ephemeralTransport,
				name: COORDINATOR_METHODS.subscribeManyGroupMessages,
				arguments: { ...input }
			}
		]);
		const stream: AsyncIterable<GroupMessage> = {
			async *[Symbol.asyncIterator]() {
				for await (const chunk of call.stream) {
					yield groupMessageSchema.parse(JSON.parse(chunk.value));
				}
			}
		};

		return {
			stream,
			result: call.result.then((result) =>
				subscribeManyGroupMessagesOutputSchema.parse(result.structuredContent)
			),
			abort: async (reason?: string) => {
				void call.stream.closed.catch(() => undefined);
				try {
					await call.abort(reason);
				} catch {
					return;
				}
			},
			// Only a still-active stream is a rebuild candidate: once finalized
			// (abort/close/fail) its own error path drives the resume, so gate on
			// isActive to skip streams already tearing down.
			isStale: (marginMs?: number) => call.stream.isActive && call.stream.isStale(marginMs)
		};
	}
}
