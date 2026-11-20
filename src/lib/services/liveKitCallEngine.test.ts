import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveKitCallEngine } from '$lib/services/liveKitCallEngine';

function fakeTrack(sid: string) {
	return { sid, attach: vi.fn(), detach: vi.fn() };
}

function setup() {
	const cameraTrack = fakeTrack('camera');
	const screenTrack = fakeTrack('screen');
	const cameraPublication = { track: cameraTrack };
	const screenPublication: { track: ReturnType<typeof fakeTrack> } = { track: screenTrack };
	const participant = {
		identity: 'peer:device',
		getTrackPublication: (kind: string) =>
			kind === 'camera'
				? cameraPublication
				: kind === 'screen_share'
					? screenPublication
					: undefined
	};
	const engine = new LiveKitCallEngine({
		onState: vi.fn(),
		onReconnectTimeout: vi.fn(),
		onDisconnected: vi.fn()
	});
	// attachVideo only reads the connected room; no room means a no-op, which is what a
	// unit test without LiveKit would otherwise get.
	Object.assign(engine as unknown as Record<string, unknown>, {
		room: { localParticipant: participant, remoteParticipants: new Map() },
		livekit: { Track: { Source: { Camera: 'camera', ScreenShare: 'screen_share' } } }
	});
	return { engine, identity: participant.identity, cameraTrack, screenTrack, screenPublication };
}

// Distinct shapes: two empty objects would compare equal in the assertions.
const cameraEl = { id: 'camera' } as unknown as HTMLMediaElement;
const screenEl = { id: 'screen' } as unknown as HTMLMediaElement;

afterEach(() => vi.unstubAllGlobals());

describe('call video attachment', () => {
	it('keeps a camera and a screen share on their own elements', () => {
		const { engine, identity, cameraTrack, screenTrack } = setup();

		engine.attachVideo(identity, cameraEl);
		engine.attachVideo(identity, screenEl, 'screen');

		expect(cameraTrack.attach).toHaveBeenCalledWith(cameraEl);
		expect(screenTrack.attach).toHaveBeenCalledWith(screenEl);
		expect(cameraTrack.attach).not.toHaveBeenCalledWith(screenEl);
		expect(screenTrack.attach).not.toHaveBeenCalledWith(cameraEl);

		engine.detachVideo(cameraEl);
		expect(cameraTrack.detach).toHaveBeenCalledWith(cameraEl);
		expect(screenTrack.detach).not.toHaveBeenCalled();
	});

	it('swaps in a replaced screen track on the registered element', () => {
		const { engine, identity, screenTrack, screenPublication } = setup();
		engine.attachVideo(identity, screenEl, 'screen');

		const nextScreen = fakeTrack('screen-2');
		screenPublication.track = nextScreen;
		engine.attachVideo(identity, screenEl, 'screen');

		expect(screenTrack.detach).toHaveBeenCalledWith(screenEl);
		expect(nextScreen.attach).toHaveBeenCalledWith(screenEl);
	});
});

describe('call audio attachment', () => {
	it('boosts remote microphone playback through the Web Audio mixer', () => {
		const appendChild = vi.fn();
		vi.stubGlobal('document', { body: { appendChild } });
		const { engine } = setup();
		const room = { on: vi.fn() };
		Object.assign(engine as unknown as Record<string, unknown>, {
			livekit: {
				RoomEvent: { TrackSubscribed: 'track_subscribed' },
				Track: {
					Kind: { Audio: 'audio' },
					Source: { ScreenShareAudio: 'screen_share_audio' }
				}
			},
			emitState: vi.fn()
		});
		(engine as unknown as { listen(value: unknown): void }).listen(room);
		const onSubscribed = room.on.mock.calls.find(([event]) => event === 'track_subscribed')?.[1];
		const element = { style: { display: '' }, remove: vi.fn() };
		const track = {
			kind: 'audio',
			source: 'microphone',
			sid: 'microphone',
			mediaStreamTrack: { id: 'microphone-media' },
			attach: vi.fn(() => element),
			setVolume: vi.fn()
		};

		onSubscribed?.(track, {}, { identity: 'peer:device' });

		expect(track.setVolume).toHaveBeenCalledWith(1.5);
		expect(appendChild).toHaveBeenCalledWith(element);
	});
});
