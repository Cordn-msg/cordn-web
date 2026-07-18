package org.cordn.background

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import org.json.JSONArray
import org.json.JSONObject
import uniffi.contextvm_ffi.Client
import uniffi.contextvm_ffi.ClientConfig
import uniffi.contextvm_ffi.EncryptionMode
import uniffi.contextvm_ffi.GiftWrapMode
import uniffi.contextvm_ffi.Keys
import java.util.concurrent.atomic.AtomicInteger

/**
 * The background poll (roadmap §5, §6, §7.2, §8). Runs with the WebView suspended.
 *
 * Per coordinator: throwaway `Keys.generate()` + stateless `Client` → one `tools/call`
 * `msg_fetch_many` with `after: nativeCursor` → parse `structuredContent.messages` → stage
 * the wire bytes verbatim into the sidecar → advance `nativeCursor` (advance-on-notify) →
 * post a count-only local notification. Never decrypts, never holds user secrets.
 */
internal class MessageFetchWorker(
    appContext: Context,
    params: WorkerParameters
) : CoroutineWorker(appContext, params) {

    companion object {
        const val CHANNEL_ID = "cordn_messages"
        private val reqId = AtomicInteger(0)
    }

    override suspend fun doWork(): Result {
        val store = BackgroundStore(applicationContext)
        val accountPubkey = store.getCurrentAccount() ?: return Result.success()
        val groups = store.pollGroups()
        if (groups.isEmpty()) return Result.success()

        // Group by coordinator — each coordinator is its own ContextVM server (own pubkey/relays).
        val byCoordinator: Map<String, List<BackgroundStore.PollGroupRow>> =
            groups.groupBy { it.coordinatorServerPubkey }

        var notifiedAny = false
        for ((serverPubkey, coordGroups) in byCoordinator) {
            try {
                notifiedAny = pollCoordinator(store, accountPubkey, serverPubkey, coordGroups) || notifiedAny
            } catch (t: Throwable) {
                // One coordinator failing must not abort the rest or retry-storm WorkManager.
                // ponytail: swallow + continue; a transient relay failure self-corrects next cycle.
                android.util.Log.w("CordnBg", "poll failed for coordinator $serverPubkey", t)
            }
        }
        return Result.success()
    }

    /** @return true if any new messages were staged+notified for this coordinator. */
    private fun pollCoordinator(
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
                val titleByGid = groups.associateBy({ it.gid }, { it.title })
                android.util.Log.i(
                    "CordnBg",
                    "staged ${toStage.size} rows across ${countByGid.size} group(s); notifying"
                )
                for ((gid, count) in countByGid) {
                    notifyGroup(gid, count, titleByGid[gid])
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

    private fun notifyGroup(gid: String, count: Int, title: String?) {
        val ctx = applicationContext
        ensureChannel(ctx)
        if (!NotificationManagerCompat.from(ctx).areNotificationsEnabled()) return

        val name = title?.takeIf { it.isNotBlank() } ?: "Cordn"
        val builder = NotificationCompat.Builder(ctx, CHANNEL_ID)
            // ponytail: system chat icon for now; dedicated ic_stat_* is Phase 4 (icon pass).
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle(name)
            .setContentText(if (count == 1) "New message" else "$count new messages")
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true)
        val tapIntent = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)
        if (tapIntent != null) {
            builder.setContentIntent(
                PendingIntent.getActivity(
                    ctx,
                    gid.hashCode(),
                    tapIntent,
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
                )
            )
        }
        val notification = builder.build()
        try {
            NotificationManagerCompat.from(ctx).notify(gid.hashCode(), notification)
            android.util.Log.i("CordnBg", "notified gid=$gid count=$count")
        } catch (t: SecurityException) {
            // POST_NOTIFICATIONS not granted — silently skip.
        }
    }

    private fun ensureChannel(ctx: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(CHANNEL_ID) == null) {
            nm.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID,
                    "Messages",
                    NotificationManager.IMPORTANCE_DEFAULT
                ).apply { description = "New chat message notifications" }
            )
        }
    }
}
