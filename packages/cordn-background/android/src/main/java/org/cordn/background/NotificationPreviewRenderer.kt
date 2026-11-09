package org.cordn.background

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.view.ContextThemeWrapper
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.URLConnection
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume

/**
 * Decrypted notification text without a visible Activity.
 *
 * The worker always creates a short-lived WebView off-screen. The visible
 * app's WebView is paused/frozen once the app is backgrounded, so asking it to
 * decrypt can leave the notification count-only forever. The hidden WebView
 * loads the tiny `/background-preview` route from the bundled assets on the SAME
 * `https://localhost` origin and reads the app's IndexedDB normally.
 *
 * The page only builds throwaway clones; the sidecar is peeked, never drained,
 * and the authoritative MLS state is never persisted. Every failure or timeout
 * leaves the count-only notification already posted by the worker in place.
 *
 * shortcut: every preview starts a hidden WebView (the backgrounded app WebView
 * freezes); add an acknowledged warm path if the cost matters. A detached WebView
 * is not a documented background API; an OEM or memory kill can lose the preview.
 * If rich text ever becomes a hard guarantee, move MLS decryption into the native
 * worker instead.
 */
internal object NotificationPreviewRenderer {
    private const val PREVIEW_URL = "https://localhost/background-preview"
    private const val PREVIEW_TIMEOUT_MS = 15_000L

    suspend fun render(context: Context) {
        val store = BackgroundStore.get(context)
        if (!store.getNotificationPreviews()) return
        val account = store.getCurrentAccount() ?: return
        if (store.peekSidecar(account).isEmpty()) return
        // Foreground notifications are suppressed entirely; the live path owns text there.
        if (CordnBackgroundPlugin.appForegrounded) return

        android.util.Log.i("CordnBg", "preview: starting hidden WebView")
        withContext(Dispatchers.Main) {
            awaitHiddenWebView(context.applicationContext, account)
        }
        android.util.Log.i("CordnBg", "preview: hidden WebView finished")
    }

    private suspend fun awaitHiddenWebView(context: Context, account: String) =
        suspendCancellableCoroutine { continuation ->
            val main = Handler(Looper.getMainLooper())
            val finished = AtomicBoolean(false)
            var webView: WebView? = null

            fun finish() {
                if (!finished.compareAndSet(false, true)) return
                if (continuation.isActive) continuation.resume(Unit)
                main.post {
                    runCatching {
                        webView?.stopLoading()
                        webView?.destroy()
                    }
                }
            }

            continuation.invokeOnCancellation { finish() }
            try {
                @SuppressLint("SetJavaScriptEnabled")
                // A theme wrapper avoids WebView's occasional getTheme() crash on a
                // bare application context; the view is never attached or shown.
                val created = WebView(ContextThemeWrapper(context, android.R.style.Theme_DeviceDefault))
                webView = created
                created.settings.apply {
                    javaScriptEnabled = true
                    domStorageEnabled = true
                    allowFileAccess = false
                    allowContentAccess = false
                    blockNetworkLoads = false
                    mediaPlaybackRequiresUserGesture = false
                }
                created.setBackgroundColor(0)
                if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                    created.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
                }
                created.webViewClient = LocalAssetClient(context)
                created.addJavascriptInterface(
                    PreviewBridge(account, context) { finish() },
                    "CordnPreviewBridge"
                )
                created.loadUrl(PREVIEW_URL)
                created.onResume()
                created.resumeTimers()
                main.postDelayed({ finish() }, PREVIEW_TIMEOUT_MS)
            } catch (t: Throwable) {
                android.util.Log.w("CordnBg", "hidden preview WebView unavailable", t)
                finish()
            }
        }

    /** Serves the bundled SPA from assets while keeping the https://localhost origin. */
    private class LocalAssetClient(private val context: Context) : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
            request.url.host != "localhost"

        override fun shouldInterceptRequest(
            view: WebView,
            request: WebResourceRequest
        ): WebResourceResponse? {
            val url = request.url
            if (url.host != "localhost") return null
            var path = url.path ?: "/"
            // SPA fallback: a route with no extension resolves to the app shell.
            if (path == "/" || !path.substringAfterLast('/', "").contains('.')) path = "/index.html"
            return openAsset(path) ?: openAsset("/index.html")
        }

        private fun openAsset(path: String): WebResourceResponse? {
            return try {
                val stream = context.assets.open("public${path}")
                val mime = URLConnection.guessContentTypeFromName(path)
                    ?: if (path.endsWith(".js")) "text/javascript" else "application/octet-stream"
                WebResourceResponse(mime, "UTF-8", stream)
            } catch (t: Throwable) {
                null
            }
        }
    }

    private class PreviewBridge(
        private val account: String,
        private val context: Context,
        private val onDone: () -> Unit
    ) {
        @JavascriptInterface
        fun getRequest(): String {
            val store = BackgroundStore.get(context)
            val rows = JSONArray()
            for (row in store.peekSidecar(account)) {
                rows.put(
                    JSONObject()
                        .put("gid", row.gid)
                        .put("cursor", row.cursor)
                        .put("msg64", row.msg64)
                        .put("at", row.at)
                )
            }
            android.util.Log.i("CordnBg", "preview: request rows=${rows.length()}")
            return JSONObject().put("accountPubkey", account).put("rows", rows).toString()
        }

        @JavascriptInterface
        fun postResult(payload: String) {
            try {
                val previews = JSONObject(payload).optJSONArray("previews") ?: JSONArray()
                android.util.Log.i("CordnBg", "preview: result entries=${previews.length()}")
                if (!CordnBackgroundPlugin.appForegrounded) {
                    Notifications.applyPreviews(context, previews)
                }
            } catch (t: Throwable) {
                android.util.Log.w("CordnBg", "preview result rejected", t)
            } finally {
                onDone()
            }
        }

        @JavascriptInterface
        fun fail(reason: String) {
            android.util.Log.w("CordnBg", "notification preview failed: $reason")
            onDone()
        }
    }
}
