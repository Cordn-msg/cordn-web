package org.cordn.background

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONArray

/**
 * Native durable store for the background poller. Owns three concerns (roadmap §5, §8):
 *  - kv config (poll interval, active account),
 *  - per-group routing + the `nativeCursor` watermark,
 *  - the sidecar (staged coordinator wire-format rows awaiting foreground drain).
 *
 * The sidecar is a replay buffer of the wire format — nothing here is decrypted, nothing
 * duplicates the WebView's data model. Namespaced per account (cross-account isolation).
 */
internal class BackgroundStore(context: Context) : SQLiteOpenHelper(
    context.applicationContext,
    DB_NAME,
    null,
    DB_VERSION
) {
    companion object {
        private const val DB_NAME = "cordn-background.db"
        private const val DB_VERSION = 1

        private const val T_CONFIG = "config" // key/value
        private const val T_GROUPS = "groups"
        private const val T_SIDECAR = "sidecar"
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
                fetch_cursor              INTEGER NOT NULL,
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
        // Phase 2 v1 — no migrations yet. Bump DB_VERSION + add migrations when the schema changes.
        if (oldVersion < newVersion) {
            db.execSQL("DROP TABLE IF EXISTS $T_SIDECAR")
            db.execSQL("DROP TABLE IF EXISTS $T_GROUPS")
            db.execSQL("DROP TABLE IF EXISTS $T_CONFIG")
            onCreate(db)
        }
    }

    // ---- kv config ----

    fun setPollIntervalMinutes(minutes: Long) = put(KV_POLL_INTERVAL, minutes.toString())

    fun getPollIntervalMinutes(default: Long): Long =
        get(KV_POLL_INTERVAL)?.toLongOrNull() ?: default

    fun setCurrentAccount(pubkey: String) = put(KV_ACCOUNT, pubkey)

    fun getCurrentAccount(): String? = get(KV_ACCOUNT)

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
        val nativeCursor: Long
    )

    /**
     * Upsert the seeded group set. For each gid: set routing + title + fetchCursor, and set
     * native_cursor = max(existing native_cursor, fetchCursor) — the watermark only ever moves
     * forward, so a foreground re-seed never causes the worker to re-poll already-staged rows.
     * Groups not in [groups] are dropped (removed groups stop being polled).
     */
    fun seedGroups(accountPubkey: String, groups: List<GroupSeed>) {
        val db = writableDatabase
        db.beginTransaction()
        try {
            setCurrentAccount(accountPubkey)
            for (g in groups) {
                // Preserve the existing native_cursor across the replace so the poller's high-watermark
                // never moves backward. SQLite < 3.24 on older Android (minSdk 24) lacks UPSERT, so a
                // read-then-write inside this transaction is the safe clamp.
                val existingCursor = db.query(
                    T_GROUPS, arrayOf("native_cursor"), "gid = ?", arrayOf(g.gid),
                    null, null, null
                ).use { c -> if (c.moveToFirst()) c.getLong(0) else 0L }
                val cv = ContentValues().apply {
                    put("gid", g.gid)
                    put("coordinator_server_pubkey", g.coordinatorServerPubkey)
                    put("relay_urls", encodeList(g.relayUrls))
                    put("title", g.title)
                    put("fetch_cursor", g.fetchCursor)
                    put("native_cursor", maxOf(existingCursor, g.fetchCursor))
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

    fun pollGroups(): List<PollGroupRow> {
        val out = ArrayList<PollGroupRow>()
        readableDatabase
            .query(
                T_GROUPS,
                arrayOf(
                    "gid", "coordinator_server_pubkey", "relay_urls", "title", "native_cursor"
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
                        nativeCursor = c.getLong(4)
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

private const val KV_POLL_INTERVAL = "poll_interval_minutes"
private const val KV_ACCOUNT = "account_pubkey"
