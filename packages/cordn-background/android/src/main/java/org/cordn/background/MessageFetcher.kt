package org.cordn.background

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import uniffi.contextvm_ffi.Client
import uniffi.contextvm_ffi.ClientConfig
import uniffi.contextvm_ffi.EncryptionMode
import uniffi.contextvm_ffi.GiftWrapMode
import uniffi.contextvm_ffi.Keys
import java.util.concurrent.atomic.AtomicInteger

/**
 * The shared background fetch (roadmap §5, §6, §7.2, §8). Used by BOTH the WorkManager
 * `MessageFetchWorker` and the `CordnNotificationService` foreground-service loop — one fetch
 * implementation, so dual-run is provably idempotent (shared `nativeCursor` MAX-clamp +
 * UNIQUE-constrained sidecar). Never decrypts, never holds user secrets.
 *
 * Per coordinator: throwaway `Keys.generate()` + stateless `Client` → one `tools/call`
 * `msg_fetch_many` with `after: nativeCursor` → parse `structuredContent.messages` → stage the
 * wire bytes verbatim into the sidecar → advance `nativeCursor` (advance-on-notify) → post a
 * count-only local notification with the cached group icon + title.
 */
internal object MessageFetcher {
    private val reqId = AtomicInteger(0)

    /** @return true if any new messages were staged+notified. */
    suspend fun run(context: Context): Boolean = withContext(Dispatchers.IO) { doFetch(context) }

    private fun doFetch(context: Context): Boolean {
        val store = BackgroundStore.get(context)
        // Guard: if the user disabled delivery, neither path should notify.
        if (store.getDeliveryMode("fast") == "off") return false
        val accountPubkey = store.getCurrentAccount() ?: return false
        // Skip meta-only rows: upsertMeta can land (title/icon) before seed() fills routing.
        // An empty coordinator means the group isn't seeded yet — seed() completes it on the next
        // background/foreground transition.
        val groups = store.pollGroups().filter { it.coordinatorServerPubkey.isNotEmpty() }
        if (groups.isEmpty()) return false

        // Group by coordinator — each coordinator is its own ContextVM server (own pubkey/relays).
        val byCoordinator: Map<String, List<BackgroundStore.PollGroupRow>> =
            groups.groupBy { it.coordinatorServerPubkey }

        var notifiedAny = false
        for ((serverPubkey, coordGroups) in byCoordinator) {
            try {
                notifiedAny = pollCoordinator(context, store, accountPubkey, serverPubkey, coordGroups) || notifiedAny
            } catch (t: Throwable) {
                // One coordinator failing must not abort the rest or retry-storm WorkManager.
                // ponytail: swallow + continue; a transient relay failure self-corrects next cycle.
                android.util.Log.w("CordnBg", "poll failed for coordinator $serverPubkey", t)
            }
        }
        if (notifiedAny) {
            // Tell a foregrounded WebView to drain the sidecar now — closes the gap where a
            // stale/rebuilding live client missed the real-time delivery. The worker only stages
            // what the live path's nativeCursor lagged, so this never fires when the live path
            // already ingested the message (no redundant drain). Backgrounded → null/suspended;
            // the foreground-transition drain then covers recovery.
            CordnBackgroundPlugin.instance?.emitSidecarUpdated()
        }
        return notifiedAny
    }

    /** @return true if any new messages were staged+notified for this coordinator. */
    private fun pollCoordinator(
        context: Context,
        store: BackgroundStore,
        accountPubkey: String,
        serverPubkey: String,
        groups: List<BackgroundStore.PollGroupRow>
    ): Boolean {
        val relayUrls = groups.first().relayUrls
        val config = ClientConfig(
            relayUrls = relayUrls,
            serverPubkey = serverPubkey,
            encryptionMode = EncryptionMode.OPTIONAL,
            giftWrapMode = GiftWrapMode.EPHEMERAL,
            isStateless = true,
            timeoutSecs = 30uL,
            discoveryRelayUrls = emptyList(),
            fallbackOperationalRelayUrls = relayUrls
        )
        val keys = Keys.generate()
        val client = Client(keys, config)
        var stagedAny = false
        try {
            client.send(buildFetchRequest(groups))
            val resp = client.recvTimeout(30uL)
            android.util.Log.d(
                "CordnBg",
                "recv coordinator=$serverPubkey msgType=${resp.msgType} payloadLen=${resp.payloadJson.length}"
            )

            val result = JSONObject(resp.payloadJson).optJSONObject("result") ?: return false
            // msg_fetch_many returns data in structuredContent — content[] is empty by design.
            val structured = result.optJSONObject("structuredContent") ?: return false
            val messages = structured.optJSONArray("messages") ?: return false

            val toStage = ArrayList<BackgroundStore.StagedRow>(messages.length())
            val maxCursorByGid = HashMap<String, Long>()
            val countByGid = HashMap<String, Int>()

            for (i in 0 until messages.length()) {
                val m = messages.optJSONObject(i) ?: continue
                val gid = m.optString("gid")
                val cursor = m.optLong("cursor", -1L)
                val msg64 = m.optString("msg_64")
                if (gid.isEmpty() || cursor <= 0 || msg64.isEmpty()) continue
                toStage += BackgroundStore.StagedRow(gid, cursor, msg64, m.optLong("at", 0L))
                maxCursorByGid.merge(gid, cursor) { a, b -> maxOf(a, b) }
                countByGid.merge(gid, 1) { a, b -> a + b }
            }

            if (toStage.isNotEmpty()) {
                store.stageSidecar(accountPubkey, toStage)
                for ((gid, maxCursor) in maxCursorByGid) store.advanceNativeCursor(gid, maxCursor)
                val groupByGid = groups.associateBy({ it.gid }, { it })
                android.util.Log.i(
                    "CordnBg",
                    "staged ${toStage.size} rows across ${countByGid.size} group(s); notifying"
                )
                for ((gid, count) in countByGid) {
                    val g = groupByGid[gid]
                    notifyGroup(context, gid, count, g?.title, g?.iconBytes)
                }
                stagedAny = true
            } else {
                android.util.Log.d("CordnBg", "no new messages for coordinator=$serverPubkey")
            }
        } finally {
            client.close()
        }
        return stagedAny
    }

    private fun buildFetchRequest(groups: List<BackgroundStore.PollGroupRow>): String {
        val args = JSONObject().apply {
            val arr = JSONArray()
            for (g in groups) {
                val o = JSONObject()
                o.put("gid", g.gid)
                // `after` must be a positive int (0 is rejected). Omit for a full fetch when
                // nativeCursor is 0 (brand-new group); otherwise fetch cursors > nativeCursor.
                if (g.nativeCursor >= 1) o.put("after", g.nativeCursor)
                arr.put(o)
            }
            put("groups", arr)
        }
        val params = JSONObject().apply {
            put("name", "msg_fetch_many")
            put("arguments", args)
        }
        return JSONObject().apply {
            put("jsonrpc", "2.0")
            put("id", "bg-${reqId.incrementAndGet()}")
            put("method", "tools/call")
            put("params", params)
        }.toString()
    }

    private fun notifyGroup(
        context: Context,
        gid: String,
        count: Int,
        title: String?,
        iconBytes: String?
    ) {
        val name = title?.takeIf { it.isNotBlank() } ?: "Cordn"
        val body = if (count == 1) "New message" else "$count new messages"
        // Shared renderer — identical icon/channel/format to the live foreground path.
        Notifications.postMessageNotification(context, gid, name, body, iconBytes)
        android.util.Log.i("CordnBg", "notified gid=$gid count=$count hasIcon=${iconBytes != null}")
    }
}
