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
import {
	type ConsumeKeyPackageInput,
	consumeKeyPackageOutputSchema,
	COORDINATOR_METHODS,
	type FetchManyGroupMessagesInput,
	type FetchGroupMessagesInput,
	fetchManyGroupMessagesOutputSchema,
	fetchGroupMessagesOutputSchema,
	fetchPendingWelcomesOutputSchema,
	listAvailableKeyPackagesOutputSchema,
	type PostGroupMessageInput,
	postGroupMessageOutputSchema,
	type PublishKeyPackageInput,
	publishKeyPackageOutputSchema,
	storeWelcomeOutputSchema,
	subscribeManyGroupMessagesOutputSchema,
	subscribeGroupMessagesOutputSchema,
	type ConsumeKeyPackageOutput,
	type FetchGroupMessagesOutput,
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
	type SubscribeGroupMessagesInput,
	type SubscribeGroupMessagesOutput,
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
	FetchGroupMessages: (input: FetchGroupMessagesInput) => Promise<FetchGroupMessagesOutput>;
	FetchManyGroupMessages: (
		input: FetchManyGroupMessagesInput
	) => Promise<FetchManyGroupMessagesOutput>;
	SubscribeGroupMessages: (input: SubscribeGroupMessagesInput) => Promise<{
		stream: AsyncIterable<GroupMessage>;
		result: Promise<SubscribeGroupMessagesOutput>;
		abort: (reason?: string) => Promise<void>;
	}>;
	SubscribeManyGroupMessages: (input: SubscribeManyGroupMessagesInput) => Promise<{
		stream: AsyncIterable<GroupMessage>;
		result: Promise<SubscribeManyGroupMessagesOutput>;
		abort: (reason?: string) => Promise<void>;
	}>;
};

export class cordnClient implements coordinatorClient {
	private stableClient: Client | null = null;
	private stableTransport: NostrClientTransport | null = null;
	private stableConnected: Promise<void> | null = null;
	private readonly ephemeralClient: Client;
	private readonly ephemeralTransport: NostrClientTransport;
	private readonly ephemeralConnected: Promise<void>;
	private readonly onHealth?: (signal: CoordinatorHealthSignal) => void;
	/** Stored for lazy stable transport construction (see connectStable). */
	private readonly stableSigner: NostrTransportOptions['signer'];
	private readonly transportBase: Omit<NostrTransportOptions, 'signer'>;

	constructor(
		options: Partial<NostrTransportOptions> & {
			privateKey?: string;
			ephemeralPrivateKey?: string;
			relays?: string[];
			onHealth?: (signal: CoordinatorHealthSignal) => void;
		} = {}
	) {
		this.ephemeralClient = new Client({
			name: 'CvmMlsDeliveryServiceClientEphemeral',
			version: '1.0.0'
		});

		const resolvedPrivateKey = options.privateKey || '';
		const resolvedEphemeralPrivateKey = options.ephemeralPrivateKey;

		const relays = options.relays || [];
		const relayHandler = new ApplesauceRelayPool(relays);
		const serverPubkey = options.serverPubkey;
		if (!serverPubkey) {
			throw new Error(
				'Missing coordinator server pubkey. Pass serverPubkey explicitly or configure the CLI entrypoint to provide one.'
			);
		}
		const { signer: providedSigner, onHealth, ...rest } = options;
		this.onHealth = onHealth;
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
				enabled: true
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

		this.ephemeralConnected = this.ephemeralClient
			.connect(this.ephemeralTransport)
			.catch((error) => {
				console.error(`Failed to connect ephemeral client to server: ${error}`);
				throw error;
			});
	}

	async disconnect(): Promise<void> {
		await Promise.all([
			this.stableConnected?.catch(() => undefined),
			this.ephemeralConnected.catch(() => undefined)
		]);
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
			this.stableConnected = this.stableClient.connect(this.stableTransport).catch((error) => {
				console.error(`Failed to connect stable client to server: ${error}`);
				throw error;
			});
		}

		return this.stableConnected;
	}

	private async call<T = unknown>(
		transportKind: 'stable' | 'ephemeral',
		name: string,
		args: Record<string, unknown>,
		schema?: ZodType<T>
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
					resetTimeoutOnProgress: true
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
			return parsed;
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			this.onHealth?.({ status: 'degraded', error: detail });
			throw error;
		}
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
			postGroupMessageOutputSchema
		);
	}

	/**
	 * Fetch queued MLS opaque group messages by group and optional cursor.
	 * @param {string} gid The group id parameter
	 * @param {number} after [optional] The after cursor parameter
	 * @returns {Promise<FetchGroupMessagesOutput>} The result of the msg_fetch operation
	 */
	async FetchGroupMessages(input: FetchGroupMessagesInput): Promise<FetchGroupMessagesOutput> {
		return this.call(
			'ephemeral',
			COORDINATOR_METHODS.fetchGroupMessages,
			input,
			fetchGroupMessagesOutputSchema
		);
	}

	async FetchManyGroupMessages(
		input: FetchManyGroupMessagesInput
	): Promise<FetchManyGroupMessagesOutput> {
		return this.call(
			'ephemeral',
			COORDINATOR_METHODS.fetchManyGroupMessages,
			input,
			fetchManyGroupMessagesOutputSchema
		);
	}

	async SubscribeGroupMessages(input: SubscribeGroupMessagesInput): Promise<{
		stream: AsyncIterable<GroupMessage>;
		result: Promise<SubscribeGroupMessagesOutput>;
		abort: (reason?: string) => Promise<void>;
	}> {
		await this.ephemeralConnected;

		const call = await callToolStream<CallToolResult>({
			client: this.ephemeralClient,
			transport: this.ephemeralTransport,
			name: COORDINATOR_METHODS.subscribeGroupMessages,
			arguments: { ...input }
		});
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
				subscribeGroupMessagesOutputSchema.parse(result.structuredContent)
			),
			abort: async (reason?: string) => {
				void call.stream.closed.catch(() => undefined);
				try {
					await call.abort(reason);
				} catch {
					return;
				}
			}
		};
	}

	async SubscribeManyGroupMessages(input: SubscribeManyGroupMessagesInput): Promise<{
		stream: AsyncIterable<GroupMessage>;
		result: Promise<SubscribeManyGroupMessagesOutput>;
		abort: (reason?: string) => Promise<void>;
	}> {
		await this.ephemeralConnected;

		const call = await callToolStream<CallToolResult>({
			client: this.ephemeralClient,
			transport: this.ephemeralTransport,
			name: COORDINATOR_METHODS.subscribeManyGroupMessages,
			arguments: { ...input }
		});
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
			}
		};
	}
}
