package org.cordn.background

import android.content.Intent
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * TS↔Kotlin bridge for receiving Android `SEND` shares (other apps → Cordn). Captures the SEND
 * intent — cold start via the activity's launch intent, warm start via `handleOnNewIntent` — and
 * drains the text to the WebView so the `/chat/share` route can present a group picker.
 *
 * The SEND intent is *not* surfaced by `@capacitor/app`'s `appUrlOpen` event (that covers `VIEW`
 * deep links only), so this plugin owns the capture. Mirrors the launch-intent drain pattern in
 * `CordnBackgroundPlugin.consumeLaunchGid`. Text-only in v1 (`EXTRA_TEXT`); media via
 * `EXTRA_STREAM` is a future additive path.
 *
 * Consumed by `nativeBridge.ts` (`routeSharedContent`), guarded there by `isNativePlatform()`.
 */
@CapacitorPlugin(name = "ShareTarget")
class ShareTargetPlugin : Plugin() {

    // Warm-start cache: a SEND delivered to the running (singleTask) activity arrives via
    // onNewIntent. Stashed here until the WebView drains it on the next resume.
    @Volatile private var pendingShareText: String? = null

    /**
     * Drain the text captured from an Android SEND intent, if any. Resolves with an empty object
     * when the app wasn't opened/resumed from a share. Consumed once — the warm-start cache is
     * cleared and the cold-start launch-intent extras are removed.
     */
    @PluginMethod
    fun consumePendingShare(call: PluginCall) {
        var text = pendingShareText
        pendingShareText = null
        if (text == null) {
            // Cold start: the SEND intent is the activity's launch intent.
            val launchIntent = (getContext() as? android.app.Activity)?.intent
            if (launchIntent?.action == Intent.ACTION_SEND) {
                text = extractSendText(launchIntent)
                // Mark consumed so a redundant call (e.g. a second resume) doesn't re-fire.
                launchIntent.removeExtra(Intent.EXTRA_TEXT)
                launchIntent.removeExtra(Intent.EXTRA_TITLE)
            }
        }
        val ret = JSObject()
        if (text != null) ret.put("text", text)
        call.resolve(ret)
    }

    // Warm start: a share while the app is backgrounded delivers the intent to the existing
    // activity via onNewIntent. Stash the text so the WebView can route on the next resume.
    override fun handleOnNewIntent(intent: Intent) {
        if (intent.action == Intent.ACTION_SEND) {
            val text = extractSendText(intent)
            if (text != null) pendingShareText = text
        }
    }

    private fun extractSendText(intent: Intent): String? {
        // EXTRA_TEXT is the share-sheet payload for text/links. Fall back to EXTRA_TITLE (some
        // apps populate only that). EXTRA_STREAM (files) is intentionally unhandled in v1.
        intent.getStringExtra(Intent.EXTRA_TEXT)?.takeIf { it.isNotBlank() }?.let { return it }
        return intent.getStringExtra(Intent.EXTRA_TITLE)?.takeIf { it.isNotBlank() }
    }
}
