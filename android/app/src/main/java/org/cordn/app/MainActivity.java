package org.cordn.app;

import android.os.Bundle;
import android.os.SystemClock;
import android.util.Log;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register the local SAF "Save as" plugin. It lives in this app module (not from npm), so
        // `cap sync` can't discover it the way it auto-registers cordn-background / nostr-signer.
        registerPlugin(SaveAsPlugin.class);
        super.onCreate(savedInstanceState);
        // Capacitor's default onRenderProcessGone returns false, which makes the whole app exit
        // when the WebView renderer is killed — typically an OOM (large backup export, long chat
        // history) or a system memory reclaim while backgrounded. Users see a "crash" with no
        // shareable logs. Instead, rebuild: recreate() tears down the dead WebView via
        // BridgeActivity.onDestroy → bridge.onDestroy() → webView.destroy() and cold-loads the
        // app — state lives in IndexedDB, so the user lands where they were. Returning true
        // claims the crash is handled, which it now is.
        getBridge().addWebViewListener(new WebViewListener() {
            // Rate-limit: if the renderer dies again within seconds of a recreate (pathological
            // startup crash), stop recycling — a blank screen the user closes beats an infinite
            // recreate flicker. Static so it survives activity instances.
            private static final long MIN_RETRY_MS = 5000;
            private static long lastRecreateAt = 0L;

            @Override
            public boolean onRenderProcessGone(WebView webView, RenderProcessGoneDetail detail) {
                Log.w("Cordn", "WebView renderer gone (crashed=" + detail.didCrash()
                        + ", priority=" + detail.rendererPriorityAtExit() + ") — recreating activity");
                if (isFinishing() || isDestroyed()) {
                    return true; // teardown already in flight; nothing to rebuild
                }
                long now = SystemClock.uptimeMillis();
                if (now - lastRecreateAt < MIN_RETRY_MS) {
                    return true;
                }
                lastRecreateAt = now;
                recreate();
                return true;
            }
        });
    }
}
