package org.cordn.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Hands the gifs.nostr.build API key to the WebView for the native GIF-search transport
 * (CapacitorHttp sends no Origin, so the Bearer key is what identifies the app there).
 *
 * The value comes from the `cordn_gifs_api_key` resValue, provisioned at build time from
 * the gitignored android/gifs.properties (CI generates it from the CORDN_GIFS_API_KEY
 * secret). Absent → empty string → the JS side shows the picker's "unavailable" state.
 *
 * Web never calls this plugin: there the browser's Origin header (our registered
 * https://cordn.net origin) identifies the app, and an Authorization header would fail
 * the API's CORS preflight anyway. Keys ship inside APKs by design — "not secret in any
 * strong sense", per nostr.build's integration guide.
 */
@CapacitorPlugin(name = "GifsApiKey")
public class GifsApiKeyPlugin extends Plugin {
    @PluginMethod
    public void getKey(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("key", getContext().getString(R.string.cordn_gifs_api_key));
        call.resolve(ret);
    }
}
