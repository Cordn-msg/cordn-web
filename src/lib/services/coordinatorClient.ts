import { Client } from '@contextvm/mcp-sdk/client';
import type { CallToolResult } from '@contextvm/mcp-sdk/types.js';
import {
	callToolStream,
	NostrClientTransport,
	OpenStreamRegistry,
	type NostrSigner,
	type NostrTransportOptions,
	PrivateKeySigner,
	type RelayHandler,
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
	}>;
};

/** Includes local connect/signing and the response, not just MCP inactivity. */
const REQUEST_TIMEOUT_MS = 20_000;

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
	private readonly relayHandler: RelayHandler;
	private readonly lifecycle = new AbortController();
	readonly signal = this.lifecycle.signal;
	readonly relays: string[];
	private disconnectPromise: Promise<void> | undefined;
	private signerOperations = 0;
	private readonly streamStarts = new Map<string, () => void>();

	get isClosed(): boolean {
		return this.signal.aborted;
	}

	get isSigning(): boolean {
		return !this.isClosed && this.signerOperations > 0;
	}

	constructor(
		options: Partial<NostrTransportOptions> & {
			privateKey?: string;
			ephemeralPrivateKey?: string;
			relays?: string[];
			/** Injected handlers are owned by this client, never shared with another client. */
			relayHandler?: RelayHandler;
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

		const serverPubkey = options.serverPubkey;
		if (!serverPubkey) {
			throw new Error(
				'Missing coordinator server pubkey. Pass serverPubkey explicitly or configure the CLI entrypoint to provide one.'
			);
		}

		const relays = options.relays?.length ? [...options.relays] : [...defaultRelays];
		this.relays = relays;
		// Client replacement must replace sockets AND cancel old publishers.
		// Only this client's stable/ephemeral transports share the pool.
		const relayHandler = options.relayHandler ?? new ApplesauceRelayPool(relays);
		this.relayHandler = relayHandler;
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
		const signer = providedSigner || new PrivateKeySigner(resolvedPrivateKey);
		this.stableSigner = this.trackSigner(
			typeof signer === 'string' ? new PrivateKeySigner(signer) : signer
		);
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
		// MCP's onprogress schema strips the CEP-41 `cvm` field. Observe the
		// SDK's validated, server-authenticated notification before that projection.
		this.ephemeralTransport.onmessageWithContext = (message) => {
			if (
				'method' in message &&
				message.method === 'notifications/progress' &&
				OpenStreamRegistry.isOpenStreamProgress(message.params) &&
				message.params.cvm.frameType === 'start'
			) {
				this.streamStarts.get(String(message.params.progressToken))?.();
			}
		};

		// Stateless initialize is local setup, not a coordinator health check.
		this.ephemeralConnected = this.connect(this.ephemeralClient, this.ephemeralTransport);
		void this.ephemeralConnected.catch(() => undefined);
	}

	/** Track actual signer work so an Android approval round-trip isn't a network reset. */
	private trackSigner(signer: NostrSigner): NostrSigner {
		const track = async <T>(operation: () => Promise<T>): Promise<T> => {
			this.signal.throwIfAborted();
			this.signerOperations += 1;
			try {
				const result = await operation();
				this.signal.throwIfAborted();
				return result;
			} finally {
				this.signerOperations -= 1;
			}
		};
		return {
			getPublicKey: () => track(() => signer.getPublicKey()),
			signEvent: (event) => track(() => signer.signEvent(event)),
			nip44: signer.nip44
				? {
						encrypt: (pubkey, plaintext) => track(() => signer.nip44!.encrypt(pubkey, plaintext)),
						decrypt: (pubkey, ciphertext) => track(() => signer.nip44!.decrypt(pubkey, ciphertext))
					}
				: undefined
		};
	}

	disconnect(): Promise<void> {
		if (this.disconnectPromise) return this.disconnectPromise;
		// Reject callers and cancel pool publishers BEFORE SDK close drains inbound tasks.
		this.lifecycle.abort(new Error('Connection closed'));
		this.streamStarts.clear();
		this.disconnectPromise = Promise.allSettled([
			this.relayHandler.disconnect(),
			this.stableTransport?.close(),
			this.ephemeralTransport.close()
		]).then(() => undefined);
		return this.disconnectPromise;
	}

	private async withDeadline<T>(
		operation: () => Promise<T>,
		timeout = REQUEST_TIMEOUT_MS
	): Promise<T> {
		this.signal.throwIfAborted();
		let onAbort!: () => void;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const interrupted = new Promise<never>((_, reject) => {
			onAbort = () => reject(this.signal.reason);
			this.signal.addEventListener('abort', onAbort, { once: true });
			timer = setTimeout(() => {
				const error = new Error(`Coordinator request timed out after ${timeout}ms`);
				this.onHealth?.({ status: 'degraded', error: error.message });
				reject(error);
				void this.disconnect();
			}, timeout);
		});
		try {
			const result = await Promise.race([operation(), interrupted]);
			this.signal.throwIfAborted();
			return result;
		} finally {
			clearTimeout(timer);
			this.signal.removeEventListener('abort', onAbort);
		}
	}

	private connect(client: Client, transport: NostrClientTransport): Promise<void> {
		return this.withDeadline(async () => {
			try {
				await client.connect(transport);
			} finally {
				// SDK start is not abortable. A late start must not resurrect subscriptions.
				if (this.isClosed) void transport.close().catch(() => undefined);
			}
		});
	}

	private connectStable(): Promise<void> {
		this.signal.throwIfAborted();
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
			this.stableConnected = this.connect(this.stableClient, this.stableTransport);
			void this.stableConnected.catch(() => undefined);
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
		try {
			const result = await this.withDeadline(async () => {
				await (transportKind === 'stable' ? this.connectStable() : this.ephemeralConnected);
				this.signal.throwIfAborted();
				const client = transportKind === 'stable' ? this.stableClient! : this.ephemeralClient;
				return client.callTool({ name, arguments: { ...args } }, undefined, {
					// Progress tokens are also required for oversized transfers. Progress
					// must not extend a finite operation's deadline, though.
					onprogress: () => undefined,
					resetTimeoutOnProgress: false,
					timeout: options.timeout ?? REQUEST_TIMEOUT_MS
				});
			}, options.timeout);

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
			if (!this.isClosed) this.onHealth?.({ status: 'degraded', error: detail });
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
	private getServerInfo(): CoordinatorServerInfo {
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
			// Queue writes should fail promptly; an ambiguous timeout is NOT replayed.
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
	}> {
		return this.withDeadline(async () => {
			await this.ephemeralConnected;
			this.signal.throwIfAborted();
			const call = await callToolStream<CallToolResult>({
				client: this.ephemeralClient,
				transport: this.ephemeralTransport,
				name: COORDINATOR_METHODS.subscribeManyGroupMessages,
				arguments: { ...input }
			});
			const started = new Promise<void>((resolve) => {
				this.streamStarts.set(call.progressToken, resolve);
			});
			// The handle exists before publication. Readiness is the server's start
			// frame; result is the final reply when the long-running stream ends.
			const result = call.result.then((reply) =>
				subscribeManyGroupMessagesOutputSchema.parse(reply.structuredContent)
			);
			void result.catch((error) => call.stream.fail(error)).catch(() => undefined);
			try {
				await Promise.race([
					started,
					call.stream.closed.then(() => {
						throw new Error('Connection closed before stream started');
					})
				]);
			} finally {
				this.streamStarts.delete(call.progressToken);
			}
			this.signal.throwIfAborted();
			this.onHealth?.({ status: 'healthy' });
			const stream: AsyncIterable<GroupMessage> = {
				async *[Symbol.asyncIterator]() {
					for await (const chunk of call.stream) {
						yield groupMessageSchema.parse(JSON.parse(chunk.value));
					}
				}
			};
			return {
				stream,
				result,
				abort: async (reason?: string) => {
					// SDK abort finalizes locally before publishing the best-effort hint.
					// Never wait for that publish on a potentially dead socket.
					void call.abort(reason).catch(() => undefined);
				}
			};
		});
	}
}
