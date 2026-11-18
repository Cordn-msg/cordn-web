import type {
	BaseKeyProvider,
	Participant,
	RemoteTrack,
	Room,
	Track,
	TrackPublication
} from 'livekit-client';

export type CallPhase = 'connecting' | 'connected' | 'reconnecting' | 'ended';

export interface CallParticipant {
	identity: string;
	isLocal: boolean;
	isSpeaking: boolean;
	microphoneEnabled: boolean;
	cameraEnabled: boolean;
}

export interface CallEngineState {
	phase: CallPhase;
	muted: boolean;
	cameraEnabled: boolean;
	participants: CallParticipant[];
}

interface EngineCallbacks {
	onState: (state: CallEngineState) => void;
	onReconnectTimeout: () => void;
	onDisconnected: () => void;
}

const RECONNECT_LIMIT_MS = 30_000;

function publicationEnabled(publication: TrackPublication | undefined): boolean {
	return Boolean(publication && !publication.isMuted);
}

export class LiveKitCallEngine {
	private room?: Room;
	private keyProvider?: BaseKeyProvider;
	private worker?: Worker;
	private livekit?: typeof import('livekit-client');
	private disposing = false;
	private reconnectTimer?: ReturnType<typeof setTimeout>;
	private audioElements = new Map<string, HTMLMediaElement>();
	private videoElements = new Map<string, HTMLMediaElement>();
	private videoTracks = new Map<HTMLMediaElement, Track>();

	constructor(private callbacks: EngineCallbacks) {}

	async join(input: {
		url: string;
		token: string;
		frameKey: string;
		keyIndex: number;
		microphoneEnabled: boolean;
		cameraEnabled: boolean;
	}): Promise<void> {
		if (this.room) throw new Error('The call is already connected');
		this.disposing = false;
		try {
			const livekit = await import('livekit-client');
			this.livekit = livekit;
			if (!livekit.isE2EESupported()) {
				throw new Error('This browser does not support encrypted calls');
			}

			// The string path is load-bearing: it selects the same PBKDF2 derivation as Android.
			class EpochKeyProvider extends livekit.BaseKeyProvider {
				async setFrameKey(frameKey: string, keyIndex: number) {
					const material = await livekit.createKeyMaterialFromString(frameKey);
					this.onSetEncryptionKey(material, undefined, keyIndex);
				}
			}
			const keyProvider = new EpochKeyProvider({
				sharedKey: true,
				keyringSize: 16,
				ratchetWindowSize: 0,
				failureTolerance: -1
			});
			const worker = new Worker(new URL('livekit-client/e2ee-worker', import.meta.url), {
				type: 'module'
			});
			const room = new livekit.Room({
				encryption: { keyProvider, worker },
				adaptiveStream: true,
				dynacast: true
			});
			this.keyProvider = keyProvider;
			this.worker = worker;
			this.room = room;
			this.listen(room);
			await keyProvider.setFrameKey(input.frameKey, input.keyIndex);
			await room.setE2EEEnabled(true);
			this.emitState('connecting');
			await room.connect(input.url, input.token, { autoSubscribe: true });
			await room.localParticipant.setMicrophoneEnabled(input.microphoneEnabled);
			await room.localParticipant.setCameraEnabled(input.cameraEnabled);
			await room.startAudio();
			this.emitState('connected');
		} catch (error) {
			await this.dispose();
			throw error;
		}
	}

	private listen(room: Room) {
		const livekit = this.livekit!;
		room.on(livekit.RoomEvent.Connected, () => {
			this.clearReconnectTimer();
			this.emitState('connected');
		});
		room.on(livekit.RoomEvent.Reconnecting, () => {
			this.emitState('reconnecting');
			this.reconnectTimer ??= setTimeout(
				() => this.callbacks.onReconnectTimeout(),
				RECONNECT_LIMIT_MS
			);
		});
		room.on(livekit.RoomEvent.Reconnected, () => {
			this.clearReconnectTimer();
			this.emitState('connected');
		});
		room.on(livekit.RoomEvent.Disconnected, () => {
			this.clearReconnectTimer();
			this.emitState('ended');
			if (!this.disposing) this.callbacks.onDisconnected();
		});
		room.on(
			livekit.RoomEvent.TrackSubscribed,
			(track: RemoteTrack, _publication: TrackPublication, participant: Participant) => {
				if (track.kind === livekit.Track.Kind.Audio) {
					const element = track.attach();
					// In the document, not merely created: a detached element is the classic
					// "connected but nobody can hear anybody".
					element.style.display = 'none';
					document.body.appendChild(element);
					this.audioElements.set(track.sid ?? track.mediaStreamTrack.id, element);
				} else {
					this.attachVideo(participant.identity);
				}
				this.emitState();
			}
		);
		room.on(livekit.RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
			track.detach();
			this.audioElements.get(track.sid ?? track.mediaStreamTrack.id)?.remove();
			this.audioElements.delete(track.sid ?? track.mediaStreamTrack.id);
			for (const [element, attached] of this.videoTracks) {
				if (attached.sid === track.sid) this.videoTracks.delete(element);
			}
			this.emitState();
		});
		for (const event of [
			livekit.RoomEvent.ParticipantConnected,
			livekit.RoomEvent.ParticipantDisconnected,
			livekit.RoomEvent.TrackPublished,
			livekit.RoomEvent.TrackUnpublished,
			livekit.RoomEvent.TrackMuted,
			livekit.RoomEvent.TrackUnmuted,
			livekit.RoomEvent.LocalTrackPublished,
			livekit.RoomEvent.LocalTrackUnpublished,
			livekit.RoomEvent.ActiveSpeakersChanged
		]) {
			room.on(event, () => this.emitState());
		}
	}

	private currentPhase(): CallPhase {
		if (!this.room) return 'ended';
		const state = this.room.state;
		if (state === this.livekit?.ConnectionState.Connected) return 'connected';
		if (state === this.livekit?.ConnectionState.Reconnecting) return 'reconnecting';
		if (state === this.livekit?.ConnectionState.Disconnected) return 'ended';
		return 'connecting';
	}

	private participantView(participant: Participant, isLocal: boolean): CallParticipant {
		const livekit = this.livekit!;
		return {
			identity: participant.identity,
			isLocal,
			isSpeaking: participant.isSpeaking,
			microphoneEnabled: publicationEnabled(
				participant.getTrackPublication(livekit.Track.Source.Microphone)
			),
			cameraEnabled: publicationEnabled(
				participant.getTrackPublication(livekit.Track.Source.Camera)
			)
		};
	}

	private emitState(phase = this.currentPhase()) {
		if (!this.room) {
			this.callbacks.onState({
				phase: 'ended',
				muted: true,
				cameraEnabled: false,
				participants: []
			});
			return;
		}
		const local = this.room.localParticipant;
		this.callbacks.onState({
			phase,
			muted: !local.isMicrophoneEnabled,
			cameraEnabled: local.isCameraEnabled,
			participants: [
				this.participantView(local, true),
				...[...this.room.remoteParticipants.values()].map((participant) =>
					this.participantView(participant, false)
				)
			]
		});
	}

	async setMuted(muted: boolean) {
		if (!this.room) return;
		await this.room.localParticipant.setMicrophoneEnabled(!muted);
		this.emitState();
	}

	async setCameraEnabled(enabled: boolean) {
		if (!this.room) return;
		await this.room.localParticipant.setCameraEnabled(enabled);
		this.emitState();
	}

	/** False when the engine has no key provider yet (still connecting): the caller
	 *  must retry rather than record the key as installed. */
	async setFrameKey(frameKey: string, keyIndex: number): Promise<boolean> {
		const provider = this.keyProvider as BaseKeyProvider & {
			setFrameKey: (key: string, index: number) => Promise<void>;
		};
		if (!provider) return false;
		await provider.setFrameKey(frameKey, keyIndex);
		return true;
	}

	/** Registers the tile and attaches a camera the participant already publishes.
	 *  A tile mounts before the subscription it needs does, so the element stays
	 *  registered and every later subscription attaches to it. */
	attachVideo(identity: string, element?: HTMLMediaElement) {
		if (!this.room || !this.livekit) return;
		if (element) this.videoElements.set(identity, element);
		const target = this.videoElements.get(identity);
		const track = this.cameraTrackOf(identity);
		if (!target || !track || this.videoTracks.get(target) === track) return;
		this.videoTracks.get(target)?.detach(target);
		this.videoTracks.delete(target);
		track.attach(target);
		this.videoTracks.set(target, track);
	}

	private cameraTrackOf(identity: string): Track | undefined {
		if (!this.room || !this.livekit) return undefined;
		const participant =
			this.room.localParticipant.identity === identity
				? this.room.localParticipant
				: this.room.remoteParticipants.get(identity);
		return participant?.getTrackPublication(this.livekit.Track.Source.Camera)?.track;
	}

	detachVideo(element: HTMLMediaElement) {
		this.videoTracks.get(element)?.detach(element);
		this.videoTracks.delete(element);
		for (const [identity, element_] of this.videoElements) {
			if (element_ === element) this.videoElements.delete(identity);
		}
	}

	private clearReconnectTimer() {
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = undefined;
	}

	async dispose() {
		this.disposing = true;
		this.clearReconnectTimer();
		for (const element of [...this.videoTracks.keys()]) this.detachVideo(element);
		this.videoElements.clear();
		for (const element of this.audioElements.values()) element.remove();
		this.audioElements.clear();
		const room = this.room;
		this.room = undefined;
		this.keyProvider = undefined;
		if (room) {
			room.removeAllListeners();
			await room.disconnect().catch(() => {});
		}
		this.worker?.terminate();
		this.worker = undefined;
		this.callbacks.onState({ phase: 'ended', muted: true, cameraEnabled: false, participants: [] });
	}
}
