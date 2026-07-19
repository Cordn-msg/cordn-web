package org.cordn.background

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Re-applies the delivery mode after device boot. WorkManager periodic work often survives
 * reboot, but the foreground service does not — this restarts it if the user chose Fast, and
 * re-schedules WorkManager as a backstop. (Android 12+ may reject a boot-time foreground-service
 * start; [PollScheduler.applyDeliveryMode] swallows that and the WM backstop + next app launch
 * cover it.)
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED,
            Intent.ACTION_LOCKED_BOOT_COMPLETED,
            "android.intent.action.QUICKBOOT_POWERON" -> PollScheduler.applyDeliveryMode(context)
        }
    }
}
