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
 * Schedules the periodic background poll. Idempotent (unique work, KEEP) so it is safe to
 * call from both the plugin (on app launch) and the boot receiver (after reboot).
 */
internal object PollScheduler {
    const val WORK_NAME = "cordn_bg_poll"
    private const val ONESHOT_NAME = "cordn_bg_poll_oneshot"

    fun schedule(context: Context) {
        val intervalMinutes = BackgroundStore(context).getPollIntervalMinutes(15)
        val request = PeriodicWorkRequestBuilder<MessageFetchWorker>(
            intervalMinutes, TimeUnit.MINUTES
        )
            .setConstraints(
                Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .build()
            )
            .build()
        WorkManager.getInstance(context)
            .enqueueUniquePeriodicWork(WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, request)
    }

    /**
     * One immediate poll per app open (KEEP'd so only one is outstanding). Pulled forward from
     * Phase 3 — it both de-risks the first FFI round-trip (seconds, not the 15-min periodic floor)
     * and gives an instant catch-up on launch. Phase 3 will refine the trigger (post-background).
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
