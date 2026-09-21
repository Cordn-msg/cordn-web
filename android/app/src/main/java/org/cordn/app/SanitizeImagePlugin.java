package org.cordn.app;

import android.graphics.Bitmap;
import android.graphics.ImageDecoder;
import android.os.Build;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
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
}
