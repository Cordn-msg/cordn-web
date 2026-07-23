package org.cordn.background

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONArray

/**
 * The only TS↔Kotlin boundary for background polling (roadmap §4.2, §8, §11.2). Exposes the seam
 * methods consumed by `nativeBridge.ts` (guarded there by `isNativePlatform()`):
 *  - `configureDelivery` → set mode + interval, then apply (start/stop service + reschedule WM),
 *  - `seed`              → push the group set + watermark + per-coordinator routing,
 *  - `upsertGroupMeta`   → refresh one group's cached title + icon bytes,
 *  - `drain`             → pull+clear the sidecar for the foreground catch-up,
 *  - `isBatteryExempted` / `requestBatteryExemption` → Doze-exemption UX.
 */
@CapacitorPlugin(name = "CordnBackground")
class CordnBackgroundPlugin : Plugin() {

    // Group id captured from a notification-tap launch (deep-link target). Filled from the launch
    // intent (cold start) or handleOnNewIntent (warm start); drained by the WebView via
    // consumeLaunchGid so a tap opens the right conversation instead of the default /chat.
    @Volatile private var pendingLaunchGid: String? = null

    @PluginMethod
    fun configureDelivery(call: PluginCall) {
        val mode = call.getString("mode", "fast") ?: "fast"
        val interval = call.getData().optLong("intervalMinutes", 5L)
        val store = BackgroundStore.get(getContext())
        store.setDeliveryMode(mode)
        store.setDeliveryIntervalMinutes(interval)
        PollScheduler.applyDeliveryMode(getContext())
        call.resolve()
    }

    @PluginMethod
    fun seed(call: PluginCall) {
        val accountPubkey = call.getString("accountPubkey")
        if (accountPubkey.isNullOrEmpty()) {
            call.reject("accountPubkey is required")
            return
        }
        val groupsArr = call.getArray("groups", JSArray()) ?: JSArray()
        val seeds = ArrayList<BackgroundStore.GroupSeed>(groupsArr.length())
        for (i in 0 until groupsArr.length()) {
            val g = groupsArr.optJSONObject(i) ?: continue
            seeds += BackgroundStore.GroupSeed(
                gid = g.getString("gid"),
                coordinatorServerPubkey = g.getString("coordinatorServerPubkey"),
                relayUrls = g.optJSONArray("relayUrls")?.toStringList() ?: emptyList(),
                title = g.optStringOrNull("title"),
                fetchCursor = g.getLong("fetchCursor")
            )
        }
        BackgroundStore.get(getContext()).seedGroups(accountPubkey, seeds)
        // A poll right after seeding (background/foreground) — KEEP'd so only one is outstanding.
        // De-risks the first FFI round-trip in seconds (not the 15-min floor) + instant catch-up.
        if (seeds.isNotEmpty()) PollScheduler.scheduleOneShot(getContext())
        call.resolve()
    }

    @PluginMethod
    fun upsertGroupMeta(call: PluginCall) {
        val gid = call.getString("gid")
        if (gid.isNullOrEmpty()) {
            call.reject("gid is required")
            return
        }
        val title = call.getString("title") // nullable when absent
        val iconBytes = call.getString("iconBytes") // nullable
        BackgroundStore.get(getContext()).upsertMeta(gid, title, iconBytes)
        call.resolve()
    }

    @PluginMethod
    fun postMessageNotification(call: PluginCall) {
        val gid = call.getString("gid")
        if (gid.isNullOrEmpty()) {
            call.reject("gid is required")
            return
        }
        // Icon + title fallback come from the native cache (kept fresh by NativeGroupMetaSync),
        // so the live TS path doesn't need to ship bytes across the bridge.
        val (cachedTitle, iconBytes) = BackgroundStore.get(getContext()).getGroupMeta(gid)
        val title = call.getString("title")?.takeIf { it.isNotBlank() } ?: cachedTitle ?: "Cordn"
        val body = call.getString("body", "New message") ?: "New message"
        Notifications.postMessageNotification(getContext(), gid, title, body, iconBytes)
        call.resolve()
    }

    @PluginMethod
    fun advanceNativeCursor(call: PluginCall) {
        val gid = call.getString("gid")
        if (gid.isNullOrEmpty()) {
            call.reject("gid is required")
            return
        }
        val cursor = call.getData().optLong("cursor", 0L)
        // MAX-clamp — only ever moves forward, so a live-path advance never rewinds the worker.
        BackgroundStore.get(getContext()).advanceNativeCursor(gid, cursor)
        call.resolve()
    }

    @PluginMethod
    fun drain(call: PluginCall) {
        val store = BackgroundStore.get(getContext())
        val account = store.getCurrentAccount()
        val messages = JSArray()
        if (account != null) {
            for (r in store.drainSidecar(account)) {
                val o = JSObject()
                o.put("gid", r.gid)
                o.put("cursor", r.cursor)
                o.put("msg64", r.msg64)
                o.put("at", r.at)
                messages.put(o)
            }
        }
        val ret = JSObject()
        ret.put("accountPubkey", account)
        ret.put("messages", messages)
        call.resolve(ret)
    }

    @PluginMethod
    fun isBatteryExempted(call: PluginCall) {
        val pm = getContext().getSystemService(Context.POWER_SERVICE) as PowerManager
        val exempted = pm.isIgnoringBatteryOptimizations(getContext().packageName)
        call.resolve(JSObject().put("exempted", exempted))
    }

    @PluginMethod
    fun requestBatteryExemption(call: PluginCall) {
        val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
        intent.data = Uri.parse("package:${getContext().packageName}")
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        getContext().startActivity(intent)
    }

    /**
     * Drain the group id captured from a notification-tap launch (if any). Returns null when the
     * app wasn't opened from a notification. Consumed once — a later cold start without a tap
     * returns null (the launch intent extra is cleared; the warm-start cache is reset).
     */
    @PluginMethod
    fun consumeLaunchGid(call: PluginCall) {
        var gid = pendingLaunchGid
        pendingLaunchGid = null
        if (gid == null) {
            val launchIntent = (getContext() as? android.app.Activity)?.intent
            gid = launchIntent?.getStringExtra(EXTRA_GID)
            if (gid != null) launchIntent?.removeExtra(EXTRA_GID)
        }
        call.resolve(JSObject().put("gid", gid))
    }

    // Warm start: a tap while the app is backgrounded delivers the PendingIntent to the existing
    // activity via onNewIntent. Capture the gid so the WebView can route on the next resume.
    override fun handleOnNewIntent(intent: Intent) {
        val gid = intent.getStringExtra(EXTRA_GID)
        if (gid != null) pendingLaunchGid = gid
    }

    /**
     * Signal the foregrounded WebView that the background worker staged sidecar bytes, so the live
     * TS layer drains immediately — closes the foregrounded live-path gap (a stale/rebuilding client
     * missed the real-time delivery). Public so the shared [MessageFetcher] can reach it via
     * [instance] (`Plugin.notifyListeners` is protected, hence this wrapper). No-op when no JS
     * listener is attached (WebView suspended/backgrounded): the foreground-transition drain in
     * nativeBridge.ts then covers recovery.
     */
    fun emitSidecarUpdated() {
        notifyListeners(EVENT_SIDECAR_UPDATED, JSObject())
    }

    // Bridge handle for the background fetcher (runs from the foreground service / WorkManager,
    // same app process). Set in load() (bridge alive), cleared in handleOnDestroy(). Null when the
    // app is cold-started by the background worker before the user opens it — then the
    // foreground-transition drain covers recovery.
    override fun load() {
        super.load()
        instance = this
    }

    override fun handleOnDestroy() {
        if (instance === this) instance = null
        super.handleOnDestroy()
    }

    companion object {
        const val EXTRA_GID = "cordn_gid"
        const val EVENT_SIDECAR_UPDATED = "sidecarUpdated"

        @Volatile
        var instance: CordnBackgroundPlugin? = null
    }
}

private fun JSONArray.toStringList(): List<String> =
    ArrayList<String>(length()).apply {
        for (i in 0 until length()) add(getString(i))
    }

private fun org.json.JSONObject.optStringOrNull(key: String): String? =
    if (has(key) && !isNull(key)) optString(key) else null
