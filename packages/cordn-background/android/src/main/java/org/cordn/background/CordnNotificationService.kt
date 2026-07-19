package org.cordn.background

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * The fast-poll foreground service (roadmap §4.2). A long-running process that polls on a
 * coroutine timer at the user-chosen interval (1/5/10 min), Doze-exempt. Far lighter than a
 * persistent websocket: it connects for a few seconds per poll and sleeps between.
 *
 * The mandatory persistent notification (low-priority `CHANNEL_SYNC`) is the visible cost of
 * sub-15-min delivery — Android requires it. Default mode is Fast@5; users switch to Standard
 * (WorkManager 15-min) or Off in Settings. Dual-run with WorkManager-15 is safe (idempotent).
 *
 * Started/stopped by [PollScheduler.applyDeliveryMode]. START_STICKY so Android restarts it if
 * it reclaims the process; [BootReceiver] re-applies the mode after a full reboot.
 */
class CordnNotificationService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    @Volatile private var loopJob: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val store = BackgroundStore.get(this)
        val intervalMin = store.getDeliveryIntervalMinutes(5)
        startForegroundSync(intervalMin)
        // Always (re)start the loop: onStartCommand re-fires on a configureDelivery re-entry, so
        // restarting is how an interval change actually takes effect (the old loop was still
        // running the old interval). Cheap — one immediate poll + the new cadence; the previous
        // loop is cancelled cooperatively at its next suspension point. START_STICKY relaunches
        // also land here, where re-starting is correct.
        loopJob?.cancel()
        loopJob = scope.launch { pollLoop(intervalMin) }
        return START_STICKY
    }

    private suspend fun pollLoop(intervalMin: Long) {
        // One immediate poll on start (catch-up), then on the cadence.
        while (true) {
            try {
                MessageFetcher.run(this@CordnNotificationService)
            } catch (cancellation: kotlinx.coroutines.CancellationException) {
                throw cancellation // cooperative cancel (interval/mode change) — not a failure
            } catch (t: Throwable) {
                android.util.Log.w("CordnBg", "service poll failed", t)
            }
            // ponytail: fixed-window sleep (not drift-corrected). A few seconds of skew across
            // thousands of polls is irrelevant for chat notifications. Upgrade to drift-corrected
            // scheduling only if precise cadence matters.
            delay(intervalMin.coerceAtLeast(1) * 60_000L)
        }
    }

    private fun startForegroundSync(intervalMin: Long) {
        val notif = Notifications.buildSyncNotification(this, intervalMin)
        // ponytail: foregroundServiceType needs API 29+. dataSync is the closest declared type
        // for "periodically fetches data"; no special permission below API 34.
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIF_ID, notif)
        }
    }

    override fun onDestroy() {
        scope.cancel()
        loopJob = null
        super.onDestroy()
    }

    companion object {
        private const val NOTIF_ID = 1

        fun start(context: Context) {
            val intent = Intent(context, CordnNotificationService::class.java)
            // try foreground start directly; on Android 12+ a background-context start may be
            // restricted, but this is only invoked from the foreground app or boot — wrapped by
            // the caller.
            context.startForegroundService(intent)
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, CordnNotificationService::class.java))
        }
    }
}
