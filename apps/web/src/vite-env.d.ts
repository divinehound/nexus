/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Where the browser reaches the API. Defaults to /api on the same origin. */
  readonly VITE_API_URL?: string;
  readonly VITE_WALLETCONNECT_PROJECT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  /** From /config.js, written by the web container at start-up (see docker/40-nexus-config.sh). */
  __NEXUS_CONFIG__?: { walletConnectProjectId?: string };
}
