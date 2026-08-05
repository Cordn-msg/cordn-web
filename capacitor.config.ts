import type { CapacitorConfig } from '@capacitor/cli';
import { KeyboardResize } from '@capacitor/keyboard';

const config: CapacitorConfig = {
  appId: 'org.cordn.app',
  appName: 'Cordn',
  webDir: 'build',
  server: {
    // Pinned so the WebView origin is https://localhost — matches the no-op guard in
    // src/service-worker.ts that keeps the SW dormant inside the native shell.
    androidScheme: 'https',
    // Native cold-start path (since Capacitor 7.3.0). The WebView loads https://localhost/chat
    // directly, so the app boots into the chat route with no landing-page flash and no client
    // redirect. Web/PWA is unaffected (this config is native-only). Deep links and notification
    // taps still override it via their launch URL. NOTE: the leading slash is required —
    // Bridge.java concatenates appStartPath onto the server URL with no separator, so 'chat' would
    // produce the mangled 'https://localhostchat'.
    appStartPath: '/chat'
  },
  android: {
    // WebView background = the app's dark theme color, so the gap behind the WebView during
    // cold-start paint and any overscroll is dark instead of white. This is the Capacitor core
    // WebView bg, NOT @capacitor/status-bar's setBackgroundColor (that one is a no-op on
    // Android 16 / targetSdk 36, which we target).
    backgroundColor: '#020617'
  },
  plugins: {
    // Edge-to-edge + safe-area insets. SystemBars ships in @capacitor/core (8.3.2+) and, with
    // its default insetsHandling:'css', injects --safe-area-inset-* CSS custom properties (read
    // by the layout with an env() fallback). Android 15+ enforces edge-to-edge at targetSdk>=35,
    // so without this the header sits under the status bar and the composer under the nav bar.
    // style:'DEFAULT' follows the system theme for status-bar icon color. No third-party
    // safe-area plugin needed on 8.4.x.
    SystemBars: {
      style: 'DEFAULT'
    },
    // Soft-keyboard handling. resizeOnFullScreen is the Android workaround that makes the
    // WebView actually resize when the keyboard opens even though edge-to-edge (targetSdk 36)
    // runs the WebView fullscreen under the system bars — without it, adjustResize is a no-op and
    // the keyboard covers the composer. `resize` is iOS-only (Native = let iOS resize natively).
    // No JS height hacks: the resized WebView + h-dvh layout lifts the composer on its own.
    Keyboard: {
      resize: KeyboardResize.Native,
      resizeOnFullScreen: true
    }
  }
};

export default config;
