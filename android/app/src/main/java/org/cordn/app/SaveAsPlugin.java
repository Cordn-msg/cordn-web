package org.cordn.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.util.Base64;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * Local plugin that opens Android's "Save as" picker (Storage Access Framework,
 * ACTION_CREATE_DOCUMENT) so the user chooses where a generated file is stored — the same native
 * UX a browser offers for downloads. Capacitor's first-party plugins do not expose this:
 * @capacitor/filesystem writes only to fixed directories, @capacitor/share is the share sheet, and
 * the popular Capawesome file-picker is input-only. Used for the encrypted backup so it lands on
 * the real filesystem at a user-chosen location (Downloads, Documents, SD card, a cloud provider…).
 *
 * The payload is staged to a file in the cache dir BEFORE the picker launches and streamed to the
 * destination Uri on return. Holding bytes in memory across the picker round-trip (the previous
 * design) was the crash two ways: (1) the app is backgrounded behind the system picker — the peak
 * memory window the OS uses to reclaim the process, and (2) base64 + decoded byte[] copies on top
 * of the WebView's own copies OOM'd large backups. Staging caps native memory at an 8 KB buffer.
 *
 * ponytail: if the process is killed while the picker is open, the write is lost (the PluginCall
 * and callback don't survive process death) and the app cold-restarts — same OS behavior every
 * picker-based app has; the backup is one tap to re-export. Completing the write across process
 * death would need a persisted pending-op (e.g. WorkManager), add that only if users actually
 * report losing exports this way.
 */
@CapacitorPlugin(name = "SaveAs")
public class SaveAsPlugin extends Plugin {

    private static final int UTF8_CHUNK_CHARS = 64 * 1024;
    private static final int IO_BUFFER = 8 * 1024;

    /** Stable cache path: overwritten by each export, so a stale file from a crashed pick self-heals. */
    private File stagedFile() {
        return new File(getContext().getCacheDir(), "saveas-pending.bin");
    }

    @PluginMethod
    public void saveAs(PluginCall call) {
        String data = call.getString("data");
        if (data == null) {
            call.reject("data is required");
            return;
        }
        String mimeType = call.getString("mimeType", "application/octet-stream");
        String suggestedName = call.getString("suggestedName", "file");
        boolean isBase64 = "base64".equals(call.getString("encoding", "base64"));

        // Stage to disk now: nothing large stays in memory while the app is backgrounded.
        try {
            stage(data, isBase64);
        } catch (Exception e) {
            stagedFile().delete();
            call.reject("could not stage payload: " + e.getMessage());
            return;
        }

        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mimeType);
        intent.putExtra(Intent.EXTRA_TITLE, suggestedName);

        startActivityForResult(call, intent, "onPicked");
    }

    private void stage(String data, boolean isBase64) throws IOException {
        try (OutputStream out = new FileOutputStream(stagedFile())) {
            if (isBase64) {
                out.write(Base64.decode(data, Base64.NO_WRAP));
            } else {
                writeUtf8Chunked(data, out);
            }
        }
    }

    /** UTF-8 encode in char chunks; never materializes the full byte[] of a multi-MB string. */
    static void writeUtf8Chunked(String data, OutputStream out) throws IOException {
        writeUtf8Chunked(data, out, UTF8_CHUNK_CHARS);
    }

    /** Package-private chunk size so the unit test can force surrogate-pair splits. */
    static void writeUtf8Chunked(String data, OutputStream out, int chunkChars) throws IOException {
        for (int start = 0; start < data.length(); ) {
            int end = Math.min(start + chunkChars, data.length());
            // Never split a surrogate pair at a chunk edge: it would encode as '?' replacement.
            if (end < data.length() && Character.isHighSurrogate(data.charAt(end - 1))) {
                end++;
            }
            out.write(data.substring(start, end).getBytes(StandardCharsets.UTF_8));
            start = end;
        }
    }

    @ActivityCallback
    private void onPicked(PluginCall call, ActivityResult result) {
        File staged = stagedFile();
        try {
            Intent data = result.getData();
            if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
                // Cancellation surfaces as RESULT_CANCELED; reject so the JS caller can toast.
                call.reject("cancelled");
                return;
            }
            Uri uri = data.getData();
            OutputStream out = getContext().getContentResolver().openOutputStream(uri);
            if (out == null) {
                call.reject("could not open output stream");
                return;
            }
            try (InputStream in = new FileInputStream(staged); OutputStream sink = out) {
                byte[] buf = new byte[IO_BUFFER];
                for (int n; (n = in.read(buf)) > 0; ) {
                    sink.write(buf, 0, n);
                }
            }
            call.resolve(new JSObject().put("uri", uri.toString()));
        } catch (Exception e) {
            call.reject("write failed: " + e.getMessage());
        } finally {
            staged.delete();
        }
    }
}
