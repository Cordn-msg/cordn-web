package org.cordn.background

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Re-applies the delivery mode after device boot. WorkManager periodic work often survives
 * reboot, but the foreground service does not — this restarts it if the user chose Fast (below
 * Android 15; on 15+ a dataSync FGS may not start from BOOT_COMPLETED, so boot only re-schedules
 * WorkManager and the FGS resumes on the next app launch).
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED,
            "android.intent.action.QUICKBOOT_POWERON" -> PollScheduler.applyDeliveryMode(context, fromBoot = true)
        }
    }
}
