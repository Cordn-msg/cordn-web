import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'org.cordn.app',
  appName: 'Cordn',
  webDir: 'build',
  server: {
    // Pinned so the WebView origin is https://localhost — matches the no-op guard in
    // src/service-worker.ts that keeps the SW dormant inside the native shell.
    androidScheme: 'https'
  }
};

export default config;
