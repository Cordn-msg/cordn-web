package org.cordn.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register the local SAF "Save as" plugin. It lives in this app module (not from npm), so
        // `cap sync` can't discover it the way it auto-registers cordn-background / nostr-signer.
        registerPlugin(SaveAsPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
