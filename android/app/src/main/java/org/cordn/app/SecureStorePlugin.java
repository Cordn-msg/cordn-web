package org.cordn.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Local plugin: tiny secure value store backed by the Android Keystore. Values are encrypted
 * with a non-exportable AES-256-GCM key that lives in secure hardware and never leaves it, so
 * the ciphertext on disk (app SharedPreferences) is unreadable anywhere but this app on this
 * device. Used to hold the automated-backup Backup Key in wrapped form — the JS layer never
 * persists it in the clear.
 *
 * The key is deliberately NOT auth-bound (setUserAuthenticationRequired=false): automated
 * backups must unwrap unattended. ponytail: this defends file extraction (stolen files can't
 * unwrap without the Keystore), not malicious code already running inside the app — for that,
 * bind the key to biometrics and prompt per use, accepting that backups need a finger.
 *
 * Note: Keystore keys die with the app (uninstall clears the Keystore entry), so a value
 * stored here is same-device only by design — recovery off-device is the caller's problem
 * (recovery key / passphrase wrapper).
 */
@CapacitorPlugin(name = "SecureStore")
public class SecureStorePlugin extends Plugin {

    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String KEY_PREFIX = "cordn_secure_";      // Keystore alias prefix
    private static final String PREFS = "cordn_secure_store";      // wrapped-blob storage
    private static final int GCM_TAG_BITS = 128;

    private SharedPreferences prefs() {
        Context ctx = getContext();
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** Get or lazily generate the non-exportable AES key for this alias (Keystore-backed). */
    private SecretKey keyFor(String alias) throws Exception {
        KeyStore ks = KeyStore.getInstance(KEYSTORE);
        ks.load(null);
        KeyStore.Entry entry = ks.getEntry(KEY_PREFIX + alias, null);
        if (entry instanceof KeyStore.SecretKeyEntry) {
            return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
        }
        KeyGenerator gen = KeyGenerator.getInstance(
                KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        gen.init(new KeyGenParameterSpec.Builder(
                KEY_PREFIX + alias,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setUserAuthenticationRequired(false)
                .build());
        return gen.generateKey();
    }

    @PluginMethod
    public void put(PluginCall call) {
        String alias = call.getString("alias");
        String value = call.getString("value");
        if (alias == null || value == null) {
            call.reject("alias and value are required");
            return;
        }
        try {
            byte[] plain = Base64.decode(value, Base64.NO_WRAP);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, keyFor(alias));
            byte[] ct = cipher.doFinal(plain);
            String iv = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP);
            String blob = Base64.encodeToString(ct, Base64.NO_WRAP);
            prefs().edit().putString(alias, iv + ":" + blob).apply();
            call.resolve();
        } catch (Exception e) {
            call.reject("put failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void get(PluginCall call) {
        String alias = call.getString("alias");
        if (alias == null) {
            call.reject("alias is required");
            return;
        }
        String stored = prefs().getString(alias, null);
        if (stored == null) {
            call.reject("not found");
            return;
        }
        try {
            String[] parts = stored.split(":", 2);
            byte[] iv = Base64.decode(parts[0], Base64.NO_WRAP);
            byte[] ct = Base64.decode(parts[1], Base64.NO_WRAP);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, keyFor(alias), new GCMParameterSpec(GCM_TAG_BITS, iv));
            byte[] plain = cipher.doFinal(ct);
            call.resolve(new JSObject().put("value",
                    Base64.encodeToString(plain, Base64.NO_WRAP)));
        } catch (Exception e) {
            // GCM tag mismatch (value tampered with) or key invalidated — treat as absent.
            call.reject("get failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void delete(PluginCall call) {
        String alias = call.getString("alias");
        if (alias == null) {
            call.reject("alias is required");
            return;
        }
        try {
            prefs().edit().remove(alias).apply();
            KeyStore ks = KeyStore.getInstance(KEYSTORE);
            ks.load(null);
            ks.deleteEntry(KEY_PREFIX + alias);
            call.resolve();
        } catch (Exception e) {
            call.reject("delete failed: " + e.getMessage());
        }
    }
}
