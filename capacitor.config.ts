import type { CapacitorConfig } from '@capacitor/cli';

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
  }
};

export default config;
