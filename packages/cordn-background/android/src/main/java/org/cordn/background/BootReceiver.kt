package org.cordn.background

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Re-schedules the periodic poll after device boot. WorkManager periodic work is not
 * guaranteed to survive a reboot on all OEMs without an explicit nudge, so this keeps
 * background notifications reliable across restarts.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED,
            Intent.ACTION_LOCKED_BOOT_COMPLETED,
            "android.intent.action.QUICKBOOT_POWERON" -> PollScheduler.schedule(context)
        }
    }
}
