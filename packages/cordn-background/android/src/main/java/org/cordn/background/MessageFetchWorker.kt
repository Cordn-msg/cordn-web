package org.cordn.background

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters

/**
 * WorkManager periodic (~15 min) + one-shot entry point (roadmap §4.2, §8). Delegates to the
 * shared [MessageFetcher] so it stays provably idempotent with the foreground-service loop
 * (shared `nativeCursor` + UNIQUE sidecar). The ~15-min periodic is the reliability backstop;
 * faster delivery runs via [CordnNotificationService].
 */
internal class MessageFetchWorker(
    appContext: Context,
    params: WorkerParameters
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        MessageFetcher.run(applicationContext)
        return Result.success()
    }
}
