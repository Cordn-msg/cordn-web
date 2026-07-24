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

import java.io.OutputStream;

/**
 * Local plugin that opens Android's "Save as" picker (Storage Access Framework,
 * ACTION_CREATE_DOCUMENT) so the user chooses where a generated file is stored — the same native
 * UX a browser offers for downloads. Capacitor's first-party plugins do not expose this:
 * @capacitor/filesystem writes only to fixed directories, @capacitor/share is the share sheet, and
 * the popular Capawesome file-picker is input-only. Used for the encrypted backup so it lands on
 * the real filesystem at a user-chosen location (Downloads, Documents, SD card, a cloud provider…).
 *
 * Only handles small payloads (backup JSON / keys): the bytes are held in memory across the picker
 * round-trip. ponytail: if this gets reused for large media, stage the payload to a temp file and
 * stream it to the destination Uri instead of buffering.
 */
@CapacitorPlugin(name = "SaveAs")
public class SaveAsPlugin extends Plugin {

    private byte[] pending;

    @PluginMethod
    public void saveAs(PluginCall call) {
        String data = call.getString("data");
        if (data == null) {
            call.reject("data is required");
            return;
        }
        String mimeType = call.getString("mimeType", "application/octet-stream");
        String suggestedName = call.getString("suggestedName", "file");

        // Stash the payload on the instance: the bytes can't ride along in the picker intent, and
        // PluginCall doesn't round-trip arbitrary data through the activity callback.
        pending = Base64.decode(data, Base64.NO_WRAP);

        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mimeType);
        intent.putExtra(Intent.EXTRA_TITLE, suggestedName);

        startActivityForResult(call, intent, "onPicked");
    }

    @ActivityCallback
    private void onPicked(PluginCall call, ActivityResult result) {
        byte[] bytes = pending;
        pending = null;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || bytes == null
                || data == null || data.getData() == null) {
            // Cancellation surfaces as RESULT_CANCELED; reject so the JS caller can toast.
            call.reject("cancelled");
            return;
        }
        Uri uri = data.getData();
        try {
            OutputStream out = getContext().getContentResolver().openOutputStream(uri);
            if (out == null) {
                call.reject("could not open output stream");
                return;
            }
            try {
                out.write(bytes);
            } finally {
                out.close();
            }
            call.resolve(new JSObject().put("uri", uri.toString()));
        } catch (Exception e) {
            call.reject("write failed: " + e.getMessage());
        }
    }
}
