import { isHex } from 'applesauce-core/helpers';
import {
	encode,
	base64ToBytes,
	bytesToBase64,
	createCommit,
	defaultCapabilities,
	defaultCredentialTypes,
	getCiphersuiteImpl,
	joinGroup,
	keyPackageDecoder,
	makeCustomExtension,
	mlsMessageEncoder,
	mlsMessageDecoder,
	nobleCryptoProvider,
	protocolVersions,
	unsafeTestingAuthenticationService,
	wireformats,
	isDefaultCredential,
	type ClientState,
	type CustomExtension,
	type GroupContextExtension,
	type KeyPackage,
	type PrivateKeyPackage,
	type Welcome
} from 'ts-mls';
import { verifyEvent, type NostrEvent } from 'nostr-tools';

export const CORDN_GROUP_METADATA_EXTENSION_TYPE = 0xc04d;
export const CLI_CIPHERSUITE = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519';

type Decoder<T> = (bytes: Uint8Array, offset: number) => [T, number] | undefined;

export interface CordnGroupMetadata {
	name: string;
	description?: string;
	icon?: string;
	imageUrl?: string;
	adminPubkeys?: string[];
}

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

function decodeExact<T>(bytes: Uint8Array, decoder: Decoder<T>, label: string): T {
	const decoded = decoder(bytes, 0);
	if (!decoded || decoded[1] !== bytes.length) {
		throw new Error(`Invalid ${label}`);
	}
	return decoded[0];
}

function hexToBytes(hex: string): Uint8Array {
	const normalized = hex.trim().toLowerCase();
	if (normalized.length % 2 !== 0 || !/^[0-9a-f]*$/.test(normalized)) {
		throw new Error('Invalid hex value');
	}

	const bytes = new Uint8Array(normalized.length / 2);
	for (let index = 0; index < normalized.length; index += 2) {
		bytes[index / 2] = Number.parseInt(normalized.slice(index, index + 2), 16);
	}
	return bytes;
}

function encodeUint16(value: number): Uint8Array {
	return Uint8Array.from([(value >> 8) & 0xff, value & 0xff]);
}

function decodeUint16(bytes: Uint8Array, offset: number): number {
	if (offset + 2 > bytes.length) {
		throw new Error('Invalid Cordn metadata: unexpected end of data');
	}
	return (bytes[offset] << 8) | bytes[offset + 1];
}

function encodeField(bytes: Uint8Array): Uint8Array {
	return new Uint8Array([...encodeUint16(bytes.length), ...bytes]);
}

function decodeField(bytes: Uint8Array, offset: number): [Uint8Array, number] {
	const length = decodeUint16(bytes, offset);
	const start = offset + 2;
	const end = start + length;
	if (end > bytes.length) {
		throw new Error('Invalid Cordn metadata: field exceeds payload length');
	}
	return [bytes.slice(start, end), end];
}

function normalizeAdminPubkeys(adminPubkeys?: string[]): string[] {
	if (!adminPubkeys?.length) return [];
	const normalized = adminPubkeys.map((value) => value.trim().toLowerCase()).filter(Boolean);
	if (new Set(normalized).size !== normalized.length) {
		throw new Error('Group metadata admin pubkeys must not contain duplicates');
	}
	for (const value of normalized) {
		if (!isHex(value)) {
			throw new Error(`Invalid admin pubkey: ${value}`);
		}
	}
	return normalized;
}

function encodeAdminPubkeys(adminPubkeys: string[]): Uint8Array {
	const chunks = adminPubkeys.map((value) => hexToBytes(value));
	const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const bytes = new Uint8Array(totalLength);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	return bytes;
}

function decodeAdminPubkeys(bytes: Uint8Array): string[] {
	if (bytes.length === 0) return [];
	if (bytes.length % 32 !== 0) {
		throw new Error('Invalid Cordn metadata: admin pubkeys payload must be 32-byte chunks');
	}

	const adminPubkeys: string[] = [];
	for (let index = 0; index < bytes.length; index += 32) {
		adminPubkeys.push(bytesToHex(bytes.slice(index, index + 32)));
	}
	return normalizeAdminPubkeys(adminPubkeys);
}

export function createCordnMetadataCapabilities() {
	const capabilities = defaultCapabilities();
	if (!capabilities.extensions.includes(CORDN_GROUP_METADATA_EXTENSION_TYPE)) {
		capabilities.extensions = [...capabilities.extensions, CORDN_GROUP_METADATA_EXTENSION_TYPE];
	}
	return capabilities;
}

export function createCredential(stablePubkey: string) {
	return {
		credentialType: defaultCredentialTypes.basic,
		identity: new TextEncoder().encode(stablePubkey)
	};
}

export function encodeCordnGroupMetadata(metadata: CordnGroupMetadata): Uint8Array {
	if (!metadata.name.trim()) {
		throw new Error('Group metadata name is required');
	}

	const encoder = new TextEncoder();
	const adminPubkeys = normalizeAdminPubkeys(metadata.adminPubkeys);
	return new Uint8Array([
		...encodeUint16(1),
		...encodeField(encoder.encode(metadata.name.trim())),
		...encodeField(encoder.encode(metadata.description?.trim() ?? '')),
		...encodeField(encodeAdminPubkeys(adminPubkeys)),
		...encodeField(encoder.encode(metadata.icon?.trim() ?? '')),
		...encodeField(encoder.encode(metadata.imageUrl?.trim() ?? ''))
	]);
}

export function decodeCordnGroupMetadata(bytes: Uint8Array): CordnGroupMetadata {
	const version = decodeUint16(bytes, 0);
	if (version !== 1) {
		throw new Error(`Unsupported Cordn metadata version: ${version}`);
	}

	const decoder = new TextDecoder();
	let offset = 2;
	const [nameBytes, afterName] = decodeField(bytes, offset);
	offset = afterName;
	const [descriptionBytes, afterDescription] = decodeField(bytes, offset);
	offset = afterDescription;
	const [adminPubkeysBytes, afterAdminPubkeys] = decodeField(bytes, offset);
	offset = afterAdminPubkeys;
	const [iconBytes, afterIcon] = decodeField(bytes, offset);
	offset = afterIcon;
	const [imageUrlBytes, afterImageUrl] = decodeField(bytes, offset);
	offset = afterImageUrl;

	if (offset !== bytes.length) {
		throw new Error('Invalid Cordn metadata: trailing bytes detected');
	}

	const name = decoder.decode(nameBytes).trim();
	if (!name) {
		throw new Error('Group metadata name is required');
	}

	const description = decoder.decode(descriptionBytes).trim();
	const icon = decoder.decode(iconBytes).trim();
	const imageUrl = decoder.decode(imageUrlBytes).trim();
	const adminPubkeys = decodeAdminPubkeys(adminPubkeysBytes);

	return {
		name,
		description: description || undefined,
		icon: icon || undefined,
		imageUrl: imageUrl || undefined,
		adminPubkeys: adminPubkeys.length ? adminPubkeys : undefined
	};
}

export function makeCordnGroupMetadataExtension(
	metadata: CordnGroupMetadata
): GroupContextExtension {
	return makeCustomExtension({
		extensionType: CORDN_GROUP_METADATA_EXTENSION_TYPE,
		extensionData: encodeCordnGroupMetadata(metadata)
	});
}

export function getCordnGroupMetadataExtension(state: ClientState): CordnGroupMetadata | undefined {
	const extension = state.groupContext.extensions.find(
		(entry) => entry.extensionType === CORDN_GROUP_METADATA_EXTENSION_TYPE
	);
	if (!extension) {
		return undefined;
	}
	return decodeCordnGroupMetadata((extension as CustomExtension).extensionData);
}

export async function getCordnCipherSuite() {
	return getCiphersuiteImpl(CLI_CIPHERSUITE, nobleCryptoProvider);
}

export function decodeWelcomeBase64(welcomeBase64: string): Welcome {
	const message = decodeExact(base64ToBytes(welcomeBase64), mlsMessageDecoder, 'welcome');
	if (message.wireformat !== wireformats.mls_welcome) {
		throw new Error('Unable to decode welcome message');
	}
	return message.welcome;
}

export function encodeWelcomeBase64(welcome: Welcome): string {
	return bytesToBase64(
		encode(mlsMessageEncoder, {
			version: protocolVersions.mls10,
			wireformat: wireformats.mls_welcome,
			welcome
		})
	);
}

export async function joinGroupFromWelcome(params: {
	welcomeBase64: string;
	keyPackage: KeyPackage;
	privateKeyPackage: PrivateKeyPackage;
}): Promise<ClientState> {
	const cipherSuite = await getCordnCipherSuite();
	return joinGroup({
		context: { cipherSuite, authService: unsafeTestingAuthenticationService },
		welcome: decodeWelcomeBase64(params.welcomeBase64),
		keyPackage: params.keyPackage,
		privateKeys: params.privateKeyPackage
	});
}

export async function addMemberToGroup(params: {
	state: ClientState;
	memberKeyPackage: KeyPackage;
}): Promise<{
	newState: ClientState;
	welcome: Welcome;
	commitMessageBase64: string;
	welcomeBase64: string;
}> {
	const cipherSuite = await getCordnCipherSuite();
	const result = await createCommit({
		context: { cipherSuite, authService: unsafeTestingAuthenticationService },
		state: params.state,
		ratchetTreeExtension: true,
		extraProposals: [
			{
				proposalType: 1,
				add: {
					keyPackage: params.memberKeyPackage
				}
			}
		]
	});

	if (!result.welcome) {
		throw new Error('Commit did not produce a welcome message');
	}

	return {
		newState: result.newState,
		welcome: result.welcome.welcome,
		commitMessageBase64: bytesToBase64(encode(mlsMessageEncoder, result.commit)),
		welcomeBase64: encodeWelcomeBase64(result.welcome.welcome)
	};
}

function decodeKeyPackageIdentity(keyPackage: KeyPackage): string {
	const credential = keyPackage.leafNode.credential;
	if (
		!isDefaultCredential(credential) ||
		credential.credentialType !== 1 ||
		!('identity' in credential)
	) {
		throw new Error('Only BasicCredential key packages are supported');
	}

	return new TextDecoder().decode(credential.identity);
}

function readKeyPackageBase64FromPublicationEvent(publicationEvent: NostrEvent): Uint8Array {
	const parsed = JSON.parse(publicationEvent.content) as {
		params?: { arguments?: { kp_64?: string; keyPackageBase64?: string } };
	};
	const keyPackageBase64 =
		parsed.params?.arguments?.kp_64 ?? parsed.params?.arguments?.keyPackageBase64;
	if (typeof keyPackageBase64 !== 'string' || !keyPackageBase64) {
		throw new Error('Missing kp_64 in publication event');
	}

	return base64ToBytes(keyPackageBase64);
}

export async function parseConsumedPublishedKeyPackage(keyPackage: {
	stablePubkey: string;
	publicationEvent: NostrEvent;
}): Promise<KeyPackage> {
	if (!verifyEvent(keyPackage.publicationEvent)) {
		throw new Error('Invalid publication event signature');
	}

	const decoded = decodeExact(
		readKeyPackageBase64FromPublicationEvent(keyPackage.publicationEvent),
		keyPackageDecoder,
		'key package'
	);
	const stablePubkey = decodeKeyPackageIdentity(decoded);
	if (stablePubkey !== keyPackage.publicationEvent.pubkey) {
		throw new Error('Key package credential identity does not match publication event signer');
	}
	if (stablePubkey !== keyPackage.stablePubkey) {
		throw new Error('Consumed key package stable pubkey does not match publication event');
	}

	return decoded;
}
