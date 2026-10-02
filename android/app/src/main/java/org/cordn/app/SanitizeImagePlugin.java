package org.cordn.app;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.ImageDecoder;
import android.net.Uri;
import android.os.Build;
import android.util.Base64;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;

/**
 * Local plugin that re-encodes a photo through the platform decoder into a clean baseline JPEG.
 * Two jobs in one pass (sender-side, always BEFORE encryption — the encrypted-media spec binds
 * mime/filename/hash to the exact plaintext, so nothing may change after):
 *
 *  1. Metadata strip: decoding to pixels and re-encoding drops all EXIF (capture location, device
 *     model, timestamps) — for a privacy-first messenger the uploaded blob should carry pixels,
 *     not identity, and it outlives group membership on content-addressed stores.
 *  2. HEIC support: the WebView cannot decode HEIC at all (Chromium has no HEVC image support);
 *     the platform decoder can. Transcoding here makes HEIC captures viewable for every receiver.
 *
 * ImageDecoder (not BitmapFactory + Matrix) applies EXIF orientation during decode, so pixels
 * stay upright with zero EXIF-parsing code and no second full-size bitmap copy. It needs API 28+
 * — the same floor as HEIF decode itself; below that the plugin rejects and the JS caller falls
 * back to the original file with a truthful label.
 */
@CapacitorPlugin(name = "SanitizeImage")
public class SanitizeImagePlugin extends Plugin {

    private static final int JPEG_QUALITY = 85;

    @PluginMethod
    public void toJpeg(PluginCall call) {
        String base64 = call.getString("base64");
        if (base64 == null) {
            call.reject("base64 is required");
            return;
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
            call.reject("Requires Android 9+ (API 28) for platform image decoding");
            return;
        }
        try {
            byte[] in = Base64.decode(base64, Base64.DEFAULT);
            Bitmap bitmap = ImageDecoder.decodeBitmap(ImageDecoder.createSource(ByteBuffer.wrap(in)));
            try {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                if (!bitmap.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out)) {
                    call.reject("JPEG encode failed");
                    return;
                }
                JSObject ret = new JSObject();
                ret.put("base64", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
                call.resolve(ret);
            } finally {
                bitmap.recycle();
            }
        } catch (IOException | OutOfMemoryError e) {
            // Undecodable bytes (not an image, or a format this device can't decode) or a bitmap
            // too large for memory: reject, and the JS caller sends the original file instead.
            call.reject("Image re-encode failed: " + e.getMessage());
        }
    }

    /**
     * Read an image from the system clipboard, if one is present, as a data URL.
     *
     * The WebView fires the page's paste event for image-only clips but delivers an EMPTY
     * clipboardData (web-facing file paste is gated behind Chromium's kClipboardFiles; verified in
     * dotnet/maui#31005), so the JS paste handler rescues the gesture by asking the platform.
     * Resolves without a dataUrl when the clipboard holds no image URI (empty, text-only, or a
     * non-image MIME); rejects on access/IO errors so the JS caller can silently no-op.
     *
     * Android 10+ restricts clipboard reads to the focused foreground app — this only ever runs
     * in response to a user paste gesture, which guarantees focus. Android 12+ shows the standard
     * "app pasted from your clipboard" toast for clips from other apps (same as every messenger).
     */
    @PluginMethod
    public void readClipboardImage(PluginCall call) {
        ClipboardManager clipboard =
                (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
        Uri uri = null;
        // getPrimaryClip() can return null even after hasPrimaryClip() (clip swapped between the
        // two binder calls), and item 0 is not guaranteed — guard both, this is a trust boundary.
        if (clipboard != null && clipboard.hasPrimaryClip()) {
            ClipData clip = clipboard.getPrimaryClip();
            if (clip != null && clip.getItemCount() > 0) {
                ClipData.Item item = clip.getItemAt(0);
                if (item != null) uri = item.getUri();
            }
        }
        if (uri == null) {
            call.resolve(new JSObject());
            return;
        }
        try {
            String mime = getContext().getContentResolver().getType(uri);
            if (mime == null || !mime.startsWith("image/")) {
                call.resolve(new JSObject());
                return;
            }
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            try (InputStream in = getContext().getContentResolver().openInputStream(uri)) {
                if (in == null) {
                    call.resolve(new JSObject());
                    return;
                }
                byte[] buffer = new byte[8192];
                for (int read; (read = in.read(buffer)) != -1; ) out.write(buffer, 0, read);
            }
            JSObject ret = new JSObject();
            ret.put("base64", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
            ret.put("mime", mime);
            call.resolve(ret);
        } catch (Exception e) {
            Log.w("Cordn", "readClipboardImage failed", e);
            call.reject("Could not read clipboard image: " + e.getMessage());
        }
    }
}
