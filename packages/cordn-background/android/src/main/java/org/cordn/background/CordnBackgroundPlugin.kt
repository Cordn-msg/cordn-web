package org.cordn.background

import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.PluginMethod
import org.json.JSONArray

/**
 * The only TS↔Kotlin boundary for background polling (roadmap §8, §11.2). Exposes the three
 * seam methods consumed by `nativeBridge.ts` (guarded there by `isNativePlatform()`):
 *  - `configure` → store poll interval + schedule the WorkManager periodic worker,
 *  - `seed`      → push the group set + fetchCursor + per-coordinator routing,
 *  - `drain`     → pull+clear the sidecar for the foreground catch-up.
 */
@CapacitorPlugin(name = "CordnBackground")
class CordnBackgroundPlugin : Plugin() {

    @PluginMethod
    fun configure(call: PluginCall) {
        val minutes = call.getLong("pollIntervalMinutes", 15L) ?: 15L
        BackgroundStore(getContext()).setPollIntervalMinutes(minutes)
        PollScheduler.schedule(getContext())
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
        BackgroundStore(getContext()).seedGroups(accountPubkey, seeds)
        // A poll right after seeding (background/foreground) — KEEP'd so only one is outstanding.
        // Pulled forward from Phase 3: de-risks the first FFI round-trip in seconds (the one-shot
        // fires on the next background transition, not the 15-min periodic floor) + instant catch-up.
        if (seeds.isNotEmpty()) PollScheduler.scheduleOneShot(getContext())
        call.resolve()
    }

    @PluginMethod
    fun drain(call: PluginCall) {
        val store = BackgroundStore(getContext())
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
}

private fun JSONArray.toStringList(): List<String> =
    ArrayList<String>(length()).apply {
        for (i in 0 until length()) add(getString(i))
    }

private fun org.json.JSONObject.optStringOrNull(key: String): String? =
    if (has(key) && !isNull(key)) optString(key) else null
