package org.cordn.background

import android.Manifest
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * Keeps an active call alive while the Android WebView is backgrounded or the screen is off.
 *
 * Android pauses WebView media/timers in the background and kills the process without a
 * foreground service. This service owns only the Android lifecycle: the ongoing notification,
 * the partial wake lock and the declared foreground-service types. Media capture and the LiveKit
 * connection stay in the page — no audio crosses this boundary.
 *
 * Types follow what is actually capturing, and each is declared only when its runtime
 * permission exists. A muted join has no mic grant yet, so it runs as `mediaPlayback`:
 * playback-only still keeps the process alive for the remote audio.
 */
class CallForegroundService : Service() {
    private var wakeLock: PowerManager.WakeLock? = null
    private var microphone = true
    private var camera = false
    private var foreground = false
    private var title = "Group call"

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_HANGUP) {
            CordnBackgroundPlugin.instance?.emitCallHangUp()
            stopSelf()
            return START_NOT_STICKY
        }
        intent?.getStringExtra(EXTRA_TITLE)?.takeIf { it.isNotBlank() }?.let { title = it }
        microphone = intent?.getBooleanExtra(EXTRA_MICROPHONE, false) ?: microphone
        camera = intent?.getBooleanExtra(EXTRA_CAMERA, false) ?: camera
        acquireWakeLock()
        return try {
            startInForeground()
            foreground = true
            START_NOT_STICKY
        } catch (t: Throwable) {
            // A type update that the system refused must not kill an already-running
            // keep-alive; a first start that fails has nothing to keep alive.
            if (!foreground) stopSelf()
            START_NOT_STICKY
        }
    }

    private fun startInForeground() {
        Notifications.ensureChannels(this)
        val notification = buildNotification()
        val types = serviceTypes()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, types)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun serviceTypes(): Int {
        var types = 0
        if (microphone && granted(Manifest.permission.RECORD_AUDIO)) {
            types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        }
        if (camera && granted(Manifest.permission.CAMERA)) {
            types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
        }
        // Nothing capturing yet (joined muted): playback-only is the legal keep-alive.
        return if (types == 0) ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK else types
    }

    private fun granted(permission: String): Boolean =
        ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

    private fun buildNotification() = NotificationCompat.Builder(this, Notifications.CHANNEL_CALL)
        .setSmallIcon(R.drawable.ic_stat_cordn)
        .setContentTitle(title)
        .setContentText("Call in progress")
        .setPriority(NotificationCompat.PRIORITY_LOW)
        .setOngoing(true)
        .setSilent(true)
        .setShowWhen(false)
        .setColor(Notifications.BRAND_COLOR)
        .setContentIntent(openAppIntent(this))
        .addAction(0, "Hang up", hangUpIntent(this))
        // Show immediately instead of Android 12's 10-second deferral: the notification is
        // the visible evidence that the mic/camera are still running.
        .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
        .build()

    private fun acquireWakeLock() {
        if (wakeLock != null) return
        val power = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Cordn:call").apply {
            setReferenceCounted(false)
            acquire()
        }
    }

    override fun onDestroy() {
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }

    companion object {
        const val EXTRA_TITLE = "title"
        const val EXTRA_MICROPHONE = "microphone"
        const val EXTRA_CAMERA = "camera"
        const val ACTION_HANGUP = "org.cordn.background.action.HANGUP"
        private const val NOTIFICATION_ID = 4312

        fun openAppIntent(ctx: Context): PendingIntent? {
            val launch = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName) ?: return null
            return PendingIntent.getActivity(
                ctx,
                1,
                launch,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }

        private fun hangUpIntent(ctx: Context): PendingIntent =
            PendingIntent.getService(
                ctx,
                2,
                Intent(ctx, CallForegroundService::class.java).setAction(ACTION_HANGUP),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
    }
}
