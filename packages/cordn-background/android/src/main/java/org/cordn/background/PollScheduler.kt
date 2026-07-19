package org.cordn.background

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

/**
 * Delivery-mode orchestration (roadmap §4.2). Applies the stored mode: schedules/cancels the
 * WorkManager periodic backstop (~15 min, hard WorkManager floor) and starts/stops the
 * [CordnNotificationService] foreground service for sub-15-min polling.
 *
 * Safe to call repeatedly (unique work KEEP; service start/stop is idempotent).
 */
internal object PollScheduler {
    const val WORK_NAME = "cordn_bg_poll"
    private const val ONESHOT_NAME = "cordn_bg_poll_oneshot"

    /** Apply the stored delivery mode. Called on app launch, mode change, and boot. */
    fun applyDeliveryMode(context: Context) {
        val mode = BackgroundStore.get(context).getDeliveryMode("fast")
        when (mode) {
            "off" -> {
                cancelPeriodic(context)
                CordnNotificationService.stop(context)
            }
            "standard" -> {
                schedulePeriodic(context)
                CordnNotificationService.stop(context)
            }
            else -> {
                // "fast" — WM-15 backstop + foreground service at the user interval.
                schedulePeriodic(context)
                startServiceSafe(context)
            }
        }
    }

    private fun startServiceSafe(context: Context) {
        try {
            CordnNotificationService.start(context)
        } catch (t: Throwable) {
            // Android 12+ may reject a background foreground-service start (e.g. straight after
            // boot). The WM-15 backstop still delivers; the app re-applies the mode on next launch.
            android.util.Log.w("CordnBg", "fg-service start rejected (WM backstop covers it)", t)
        }
    }

    /** The ~15-min reliability backstop (always-on for standard + fast). */
    fun schedulePeriodic(context: Context) {
        val request = PeriodicWorkRequestBuilder<MessageFetchWorker>(15, TimeUnit.MINUTES)
            .setConstraints(
                Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .build()
            )
            .build()
        WorkManager.getInstance(context)
            .enqueueUniquePeriodicWork(WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, request)
    }

    fun cancelPeriodic(context: Context) {
        WorkManager.getInstance(context).cancelUniqueWork(WORK_NAME)
    }

    /**
     * One immediate poll per app open (KEEP'd so only one is outstanding). De-risks the first FFI
     * round-trip (seconds, not the 15-min floor) and gives an instant catch-up on launch.
     */
    fun scheduleOneShot(context: Context) {
        val request = OneTimeWorkRequestBuilder<MessageFetchWorker>()
            .setConstraints(
                Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .build()
            )
            .build()
        WorkManager.getInstance(context)
            .enqueueUniqueWork(ONESHOT_NAME, ExistingWorkPolicy.KEEP, request)
    }
}
