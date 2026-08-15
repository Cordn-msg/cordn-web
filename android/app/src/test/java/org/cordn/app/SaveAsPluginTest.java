package org.cordn.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

import org.junit.Test;

/**
 * Locks the trickiest bit of the staged-save path: chunked UTF-8 encoding must be byte-identical
 * to encoding the whole string at once, even when chunk boundaries land inside surrogate pairs
 * (emoji), and must not loop or throw on a malformed lone surrogate.
 */
public class SaveAsPluginTest {

    @Test
    public void chunkedUtf8MatchesWholeStringEncoding() throws Exception {
        // Odd chunk size guarantees boundaries inside 2-char emoji surrogates.
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 500; i++) {
            sb.append("aé漢😀\uD83C\uDF89z");
        }
        String data = sb.toString();

        ByteArrayOutputStream out = new ByteArrayOutputStream();
        SaveAsPlugin.writeUtf8Chunked(data, out, 3);

        assertArrayEquals(data.getBytes(StandardCharsets.UTF_8), out.toByteArray());
    }

    @Test
    public void loneTrailingSurrogateDoesNotLoopOrThrow() throws Exception {
        // Malformed input (a high surrogate cut off): must terminate and produce a valid
        // replacement-char encoding, not an infinite loop or IndexOutOfBounds.
        String data = "abc\uD83D";

        ByteArrayOutputStream out = new ByteArrayOutputStream();
        SaveAsPlugin.writeUtf8Chunked(data, out, 2);

        String decoded = new String(out.toByteArray(), StandardCharsets.UTF_8);
        assertTrue(decoded.startsWith("abc"));
    }

    @Test
    public void emptyStringWritesNothing() throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        SaveAsPlugin.writeUtf8Chunked("", out, 3);
        assertTrue(Arrays.equals(new byte[0], out.toByteArray()));
    }
}
