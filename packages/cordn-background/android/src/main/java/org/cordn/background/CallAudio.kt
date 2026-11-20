package org.cordn.background

import android.app.Activity
import android.content.Context
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import java.lang.ref.WeakReference

/**
 * Puts Android into call audio mode and routes output/capture to the best available device.
 *
 * Without this the WebView's call audio is treated as ordinary media: the hardware volume keys
 * change media volume and a connected headset is often ignored. The route is applied before the
 * microphone opens so capture also comes from the headset, and re-applied when the device set
 * changes (headset connected or removed mid-call).
 */
object CallAudio {
    private var activityRef: WeakReference<Activity>? = null
    private var audioManager: AudioManager? = null
    private var started = false
    private var generation = 0

    /** Returns a token for this call's audio session; a later start invalidates it. */
    fun start(context: Context, activity: Activity?): Int {
        generation++
        val token = generation
        try {
            val am = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return token
            audioManager = am
            activityRef = activity?.let { WeakReference(it) }
            activity?.let { activity ->
                activity.runOnUiThread {
                    activity.volumeControlStream = AudioManager.STREAM_VOICE_CALL
                }
            }
            if (!started) {
                am.registerAudioDeviceCallback(deviceCallback, Handler(Looper.getMainLooper()))
                started = true
            }
            am.mode = AudioManager.MODE_IN_COMMUNICATION
            applyRoute(am)
        } catch (_: Throwable) {
            // Routing is best-effort: a call without it still connects, just with worse audio.
        }
        return token
    }

    /** A token stops only its own session; a stale service teardown must not kill a new call. */
    fun stop(context: Context, token: Int? = null) {
        if (token != null && token != 0 && token != generation) return
        try {
            val am = audioManager
                ?: context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
                ?: return
            if (started) {
                started = false
                am.unregisterAudioDeviceCallback(deviceCallback)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                am.clearCommunicationDevice()
            }
            @Suppress("DEPRECATION")
            am.isSpeakerphoneOn = false
            @Suppress("DEPRECATION")
            am.stopBluetoothSco()
            @Suppress("DEPRECATION")
            am.isBluetoothScoOn = false
            am.mode = AudioManager.MODE_NORMAL
            activityRef?.get()?.let { activity ->
                activity.runOnUiThread {
                    activity.volumeControlStream = AudioManager.USE_DEFAULT_STREAM_TYPE
                }
            }
        } catch (_: Throwable) {
            // Nothing else depends on the teardown.
        } finally {
            activityRef = null
            audioManager = null
        }
    }

    private val deviceCallback = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) {
            audioManager?.let { applyRoute(it) }
        }

        override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) {
            audioManager?.let { applyRoute(it) }
        }
    }

    private fun applyRoute(am: AudioManager) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val devices = am.availableCommunicationDevices
            val preferred = devices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BLE_HEADSET }
                ?: devices.firstOrNull { it.type == AudioDeviceInfo.TYPE_HEARING_AID }
                ?: devices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO }
                ?: devices.firstOrNull { it.type == AudioDeviceInfo.TYPE_WIRED_HEADSET }
                ?: devices.firstOrNull { it.type == AudioDeviceInfo.TYPE_USB_HEADSET }
                ?: devices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
            if (preferred != null && !am.setCommunicationDevice(preferred)) {
                // Selection can fail while a headset is still connecting; fall back to the
                // speaker so the call is audible rather than silent.
                @Suppress("DEPRECATION")
                am.isSpeakerphoneOn = true
            }
        } else {
            val outputs = am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
            val hasWired = outputs.any {
                it.type == AudioDeviceInfo.TYPE_WIRED_HEADSET ||
                    it.type == AudioDeviceInfo.TYPE_USB_HEADSET
            }
            val hasBluetooth = outputs.any { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO }
            when {
                hasWired -> {
                    @Suppress("DEPRECATION")
                    am.isSpeakerphoneOn = false
                    @Suppress("DEPRECATION")
                    am.stopBluetoothSco()
                    @Suppress("DEPRECATION")
                    am.isBluetoothScoOn = false
                }
                hasBluetooth -> {
                    @Suppress("DEPRECATION")
                    am.isSpeakerphoneOn = false
                    @Suppress("DEPRECATION")
                    am.startBluetoothSco()
                    @Suppress("DEPRECATION")
                    am.isBluetoothScoOn = true
                }
                else -> {
                    @Suppress("DEPRECATION")
                    am.isSpeakerphoneOn = true
                    @Suppress("DEPRECATION")
                    am.stopBluetoothSco()
                    @Suppress("DEPRECATION")
                    am.isBluetoothScoOn = false
                }
            }
        }
    }
}
