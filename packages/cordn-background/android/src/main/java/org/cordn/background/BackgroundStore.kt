package org.cordn.background

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONArray

/**
 * Native durable store for the background poller. Owns four concerns (roadmap §4.2, §5, §8):
 *  - kv config (poll interval, active account, delivery mode + interval),
 *  - per-group routing + the `nativeCursor` watermark + cached display title + icon bytes,
 *  - the sidecar (staged coordinator wire-format rows awaiting foreground drain).
 *
 * The sidecar is a replay buffer of the wire format — nothing here is decrypted, nothing
 * duplicates the WebView's data model. Namespaced per account (cross-account isolation).
 */
internal class BackgroundStore private constructor(context: Context) : SQLiteOpenHelper(
    context.applicationContext,
    DB_NAME,
    null,
    DB_VERSION
) {
    companion object {
        private const val DB_NAME = "cordn-background.db"
        private const val DB_VERSION = 3 // v3: dropped inert fetch_cursor (worker uses native_cursor only)

        private const val T_CONFIG = "config" // key/value
        private const val T_GROUPS = "groups"
        private const val T_SIDECAR = "sidecar"

        @Volatile
        private var instance: BackgroundStore? = null

        /**
         * Process-wide singleton. The background layer opens the store from several components
         * (plugin, worker, service, scheduler); a single shared SQLiteOpenHelper reuses one
         * connection pool instead of leaking a connection per open — the old direct constructor
         * leaked on every call ("SQLiteConnection object for database … was leaked").
         * SQLiteOpenHelper is thread-safe; the connection is held for the process lifetime.
         */
        fun get(context: Context): BackgroundStore =
            instance ?: synchronized(this) {
                instance ?: BackgroundStore(context.applicationContext).also { instance = it }
            }
    }

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS $T_CONFIG (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
            """.trimIndent()
        )
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS $T_GROUPS (
                gid                       TEXT PRIMARY KEY,
                coordinator_server_pubkey TEXT NOT NULL,
                relay_urls                TEXT NOT NULL,
                title                     TEXT,
                icon_bytes                TEXT,
                native_cursor             INTEGER NOT NULL
            )
            """.trimIndent()
        )
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS $T_SIDECAR (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                account_pubkey TEXT NOT NULL,
                gid            TEXT NOT NULL,
                cursor         INTEGER NOT NULL,
                msg64          TEXT NOT NULL,
                at             INTEGER NOT NULL,
                UNIQUE(account_pubkey, gid, cursor)
            )
            """.trimIndent()
        )
        db.execSQL(
            "CREATE INDEX IF NOT EXISTS idx_sidecar_account ON $T_SIDECAR(account_pubkey, gid, cursor)"
        )
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        // Pre-release: the schema is still in flux, so on a version bump just rebuild from scratch
        // (the app re-seeds groups + nativeCursor from the WebView state on next launch; the sidecar
        // is a replay buffer). Avoids per-column ALTER ceremony (SQLite < 3.35 can't DROP COLUMN).
        db.execSQL("DROP TABLE IF EXISTS $T_GROUPS")
        db.execSQL("DROP TABLE IF EXISTS $T_SIDECAR")
        onCreate(db)
    }

    // ---- kv config ----

    fun setCurrentAccount(pubkey: String) = put(KV_ACCOUNT, pubkey)

    fun getCurrentAccount(): String? = get(KV_ACCOUNT)

    fun setDeliveryMode(mode: String) = put(KV_DELIVERY_MODE, mode)

    fun getDeliveryMode(default: String): String = get(KV_DELIVERY_MODE) ?: default

    fun setDeliveryIntervalMinutes(minutes: Long) = put(KV_DELIVERY_INTERVAL, minutes.toString())

    fun getDeliveryIntervalMinutes(default: Long): Long =
        get(KV_DELIVERY_INTERVAL)?.toLongOrNull() ?: default

    private fun put(key: String, value: String) {
        val cv = ContentValues().apply { put("key", key); put("value", value) }
        writableDatabase.insertWithOnConflict(T_CONFIG, null, cv, SQLiteDatabase.CONFLICT_REPLACE)
    }

    private fun get(key: String): String? {
        readableDatabase
            .query(T_CONFIG, arrayOf("value"), "key=?", arrayOf(key), null, null, null)
            .use { c -> if (c.moveToFirst()) return c.getString(0) }
        return null
    }

    // ---- groups ----

    data class PollGroupRow(
        val gid: String,
        val coordinatorServerPubkey: String,
        val relayUrls: List<String>,
        val title: String?,
        val iconBytes: String?,
        val nativeCursor: Long
    )

    /**
     * Upsert the seeded group set. For each gid: set routing + title + watermark, and set
     * native_cursor = max(existing native_cursor, watermark) — the watermark only ever moves
     * forward, so a foreground re-seed never causes the worker to re-poll already-staged rows.
     * Preserves cached icon_bytes across the replace. Groups not in [groups] are dropped.
     */
    fun seedGroups(accountPubkey: String, groups: List<GroupSeed>) {
        val db = writableDatabase
        db.beginTransaction()
        try {
            setCurrentAccount(accountPubkey)
            for (g in groups) {
                // Preserve native_cursor + icon_bytes across the replace so the poller's
                // high-watermark and cached icon never reset on a foreground re-seed.
                // SQLite < 3.24 on older Android (minSdk 24) lacks UPSERT, so a read-then-write
                // inside this transaction is the safe clamp.
                val existing = db.query(
                    T_GROUPS,
                    arrayOf("native_cursor", "icon_bytes", "title"),
                    "gid = ?",
                    arrayOf(g.gid),
                    null, null, null
                ).use { c ->
                    if (c.moveToFirst()) Triple(
                        c.getLong(0),
                        if (c.isNull(1)) null else c.getString(1),
                        if (c.isNull(2)) null else c.getString(2)
                    ) else Triple(0L, null, null)
                }
                val cv = ContentValues().apply {
                    put("gid", g.gid)
                    put("coordinator_server_pubkey", g.coordinatorServerPubkey)
                    put("relay_urls", encodeList(g.relayUrls))
                    // Preserve the meta-sync's (profile-aware) title across a re-seed; the seed's
                    // title is computed without profile hints, so only use it as a first-seed fallback.
                    put("title", existing.third ?: g.title)
                    put("icon_bytes", existing.second)
                    put("native_cursor", maxOf(existing.first, g.fetchCursor))
                }
                db.insertWithOnConflict(T_GROUPS, null, cv, SQLiteDatabase.CONFLICT_REPLACE)
            }
            if (groups.isEmpty()) {
                db.delete(T_GROUPS, null, null)
            } else {
                val placeholders = groups.joinToString(",") { "?" }
                db.delete(T_GROUPS, "gid NOT IN ($placeholders)", groups.map { it.gid }.toTypedArray())
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    /**
     * Refresh one group's cached display title + icon bytes (rendered by the WebView). Upserts —
     * INSERT-or-REPLACE preserving existing routing/cursors, so a meta-sync that fires BEFORE the
     * first seed still lands (a plain UPDATE was a silent no-op on an unseeded group, which is why
     * the worker used to get no title/icon). The worker skips the resulting meta-only rows until
     * seed() fills their routing.
     */
    fun upsertMeta(gid: String, title: String?, iconBytes: String?) {
        val db = writableDatabase
        db.beginTransaction()
        try {
            data class Existing(val coord: String, val relays: String, val native: Long)
            val existing = db.query(
                T_GROUPS,
                arrayOf("coordinator_server_pubkey", "relay_urls", "native_cursor"),
                "gid = ?",
                arrayOf(gid),
                null, null, null
            ).use { c ->
                if (c.moveToFirst()) Existing(c.getString(0), c.getString(1), c.getLong(2)) else null
            }
            val cv = ContentValues().apply {
                put("gid", gid)
                put("title", title)
                put("icon_bytes", iconBytes)
                val e = existing
                if (e != null) {
                    put("coordinator_server_pubkey", e.coord)
                    put("relay_urls", e.relays)
                    put("native_cursor", e.native)
                } else {
                    put("coordinator_server_pubkey", "")
                    put("relay_urls", "[]")
                    put("native_cursor", 0)
                }
            }
            db.insertWithOnConflict(T_GROUPS, null, cv, SQLiteDatabase.CONFLICT_REPLACE)
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    /** One group's cached (title, iconBytes) — for the live native-notification poster. */
    fun getGroupMeta(gid: String): Pair<String?, String?> {
        readableDatabase
            .query(T_GROUPS, arrayOf("title", "icon_bytes"), "gid = ?", arrayOf(gid), null, null, null)
            .use { c ->
                if (c.moveToFirst()) {
                    return Pair(if (c.isNull(0)) null else c.getString(0), if (c.isNull(1)) null else c.getString(1))
                }
            }
        return Pair(null, null)
    }

    fun pollGroups(): List<PollGroupRow> {
        val out = ArrayList<PollGroupRow>()
        readableDatabase
            .query(
                T_GROUPS,
                arrayOf(
                    "gid", "coordinator_server_pubkey", "relay_urls", "title", "icon_bytes", "native_cursor"
                ),
                null, null, null, null, null
            )
            .use { c ->
                while (c.moveToNext()) {
                    out += PollGroupRow(
                        gid = c.getString(0),
                        coordinatorServerPubkey = c.getString(1),
                        relayUrls = decodeList(c.getString(2)),
                        title = if (c.isNull(3)) null else c.getString(3),
                        iconBytes = if (c.isNull(4)) null else c.getString(4),
                        nativeCursor = c.getLong(5)
                    )
                }
            }
        return out
    }

    fun advanceNativeCursor(gid: String, cursor: Long) {
        writableDatabase.execSQL(
            "UPDATE $T_GROUPS SET native_cursor = MAX(native_cursor, ?) WHERE gid = ?",
            arrayOf<Any>(cursor, gid)
        )
    }

    // ---- sidecar ----

    data class StagedRow(val gid: String, val cursor: Long, val msg64: String, val at: Long)

    /** Stage fetched wire rows. Idempotent per (account, gid, cursor) via the UNIQUE constraint. */
    fun stageSidecar(accountPubkey: String, rows: List<StagedRow>) {
        if (rows.isEmpty()) return
        val db = writableDatabase
        db.beginTransaction()
        try {
            for (r in rows) {
                val cv = ContentValues().apply {
                    put("account_pubkey", accountPubkey)
                    put("gid", r.gid)
                    put("cursor", r.cursor)
                    put("msg64", r.msg64)
                    put("at", r.at)
                }
                db.insertWithOnConflict(T_SIDECAR, null, cv, SQLiteDatabase.CONFLICT_IGNORE)
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    /** Return all staged rows for the active account and clear them (foreground drain). */
    fun drainSidecar(accountPubkey: String): List<StagedRow> {
        val out = ArrayList<StagedRow>()
        val db = writableDatabase
        db.beginTransaction()
        try {
            db.query(
                T_SIDECAR,
                arrayOf("gid", "cursor", "msg64", "at"),
                "account_pubkey = ?",
                arrayOf(accountPubkey),
                null, null, "gid ASC, cursor ASC"
            ).use { c ->
                while (c.moveToNext()) {
                    out += StagedRow(
                        gid = c.getString(0),
                        cursor = c.getLong(1),
                        msg64 = c.getString(2),
                        at = c.getLong(3)
                    )
                }
            }
            db.delete(T_SIDECAR, "account_pubkey = ?", arrayOf(accountPubkey))
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
        return out
    }

    // ---- helpers ----

    data class GroupSeed(
        val gid: String,
        val coordinatorServerPubkey: String,
        val relayUrls: List<String>,
        val title: String?,
        val fetchCursor: Long
    )

    private fun encodeList(list: List<String>): String {
        val arr = JSONArray()
        for (s in list) arr.put(s)
        return arr.toString()
    }

    private fun decodeList(json: String): List<String> {
        return try {
            val arr = JSONArray(json)
            ArrayList<String>(arr.length()).apply {
                for (i in 0 until arr.length()) add(arr.getString(i))
            }
        } catch (e: Exception) {
            emptyList()
        }
    }
}

private const val KV_ACCOUNT = "account_pubkey"
private const val KV_DELIVERY_MODE = "delivery_mode"
private const val KV_DELIVERY_INTERVAL = "delivery_interval_minutes"
