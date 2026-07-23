package org.cordn.background

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Build
import android.util.Base64
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * Shared notification plumbing (roadmap §4.4). Two channels: message notifications (default
 * importance, sound) and the sync foreground-service notification (low importance, silent).
 * Also the home of the brand color and the persistent-service notification builder used by
 * `CordnNotificationService`.
 */
internal object Notifications {
    const val CHANNEL_MESSAGES = "cordn_messages"
    const val CHANNEL_SYNC = "cordn_sync"

    /** Near-black to match the app primary (oklch(0.205 0 0)) + launcher. */
    const val BRAND_COLOR = 0xFF1C1C1C.toInt()

    fun ensureChannels(ctx: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(CHANNEL_MESSAGES) == null) {
            nm.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_MESSAGES,
                    "Messages",
                    NotificationManager.IMPORTANCE_DEFAULT
                ).apply { description = "New chat message notifications" }
            )
        }
        if (nm.getNotificationChannel(CHANNEL_SYNC) == null) {
            nm.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_SYNC,
                    "Background sync",
                    NotificationManager.IMPORTANCE_LOW
                ).apply {
                    description = "Keeps Cordn checking for new messages"
                    setShowBadge(false)
                }
            )
        }
    }

    /**
     * The persistent foreground-service notification. Low priority + no badge so it stays
     * unobtrusive in the shade. This is the mandatory visible cost of Fast/Live delivery modes
     * (roadmap §4.2) — Android requires it for a long-running foreground service.
     */
    fun buildSyncNotification(ctx: Context, intervalMinutes: Long): Notification {
        ensureChannels(ctx)
        val minutesText = if (intervalMinutes < 1) "every moment" else "every $intervalMinutes min"
        return NotificationCompat.Builder(ctx, CHANNEL_SYNC)
            .setSmallIcon(R.drawable.ic_stat_cordn)
            .setContentTitle("Cordn")
            .setContentText("Checking for messages $minutesText")
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(true)
            .setShowWhen(false)
            .setColor(BRAND_COLOR)
            .build()
    }

    /** Decode cached base64 PNG bytes (rendered by the WebView) into a largeIcon bitmap, or null. */
    fun decodeIcon(iconBytes: String?): Bitmap? {
        if (iconBytes.isNullOrEmpty()) return null
        return try {
            val bytes = Base64.decode(iconBytes, Base64.NO_WRAP)
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        } catch (t: Throwable) {
            null
        }
    }

    /**
     * Unified message-notification poster (notification consolidation, roadmap §4.4). The SINGLE
     * renderer for BOTH the background worker (count-only body) and the live foreground path
     * (decrypted sender/text body, routed here from `showLocalNotification` on native) — same
     * smallIcon, channel, brand color, and per-group id (a burst coalesces; latest message wins).
     * Web notifications stay on the browser Notification API (unchanged); this is native parity.
     *
     * No `.setGroup`: each group is its own notification id, so multiple groups never collapse
     * into Android's auto-summary (the old "copy/stack" icon).
     *
     * ponytail: simple title+body per group. MessagingStyle per-room accumulation (armada's
     * NotificationRelayService pattern) is the upgrade path once multi-message threading matters.
     */
    fun postMessageNotification(
        ctx: Context,
        gid: String,
        title: String,
        body: String,
        iconBytes: String?
    ) {
        ensureChannels(ctx)
        if (!NotificationManagerCompat.from(ctx).areNotificationsEnabled()) return
        val builder = NotificationCompat.Builder(ctx, CHANNEL_MESSAGES)
            .setSmallIcon(R.drawable.ic_stat_cordn)
            .setContentTitle(title)
            .setContentText(body)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true)
            .setColor(BRAND_COLOR)
        decodeIcon(iconBytes)?.let { builder.setLargeIcon(it) }
        val tapIntent = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)
        if (tapIntent != null) {
            // Carry the group id so a tap deep-links into the conversation (routeLaunchGid on resume).
            tapIntent.putExtra(CordnBackgroundPlugin.EXTRA_GID, gid)
            builder.setContentIntent(
                PendingIntent.getActivity(
                    ctx,
                    gid.hashCode(),
                    tapIntent,
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
                )
            )
        }
        try {
            NotificationManagerCompat.from(ctx).notify(gid.hashCode(), builder.build())
        } catch (t: SecurityException) {
            // POST_NOTIFICATIONS not granted — silently skip.
        }
    }
}
