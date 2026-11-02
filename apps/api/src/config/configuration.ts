export default () => ({
  port: parseInt(process.env.API_PORT || '4000', 10),
  database: {
    url: process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/nexus',
  },
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },
  jwt: {
    secret: process.env.JWT_SECRET || 'nexus-dev-secret-change-in-production',
  },
  auth: {
    // Google sign-in: the OAuth client id (Web application) from Google Cloud console.
    googleClientId: process.env.GOOGLE_CLIENT_ID || '',
    // Emailed sign-in codes are sent through Resend. Without a key, codes are
    // only written to the API log (outside production).
    resendApiKey: process.env.RESEND_API_KEY || '',
    emailFrom: process.env.EMAIL_FROM || 'Nexus <no-reply@nexus.local>',
    // Passkeys: the site's domain (no scheme or port) and the web origins allowed
    // to use them. Both default to WEB_URL.
    webauthnRpId: process.env.WEBAUTHN_RP_ID || new URL(process.env.WEB_URL || 'http://localhost:3000').hostname,
    webauthnOrigins: (process.env.WEBAUTHN_ORIGINS || process.env.WEB_URL || 'http://localhost:3000')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  },
  alchemy: {
    apiKey: process.env.ALCHEMY_API_KEY || '',
  },
  helius: {
    apiKey: process.env.HELIUS_API_KEY || '',
  },
  coingecko: {
    // Optional. Free public API works without a key (rate-limited); a Pro/Demo
    // key raises limits and switches to the pro-api host.
    apiKey: process.env.COINGECKO_API_KEY || '',
  },
  relay: {
    // Optional. Relay bridges are paired from Relay's public history without a
    // key; with one, requests made through this key's own integration (GET
    // /requests/v3) are read too. Self-serve key from dashboard.relay.link.
    apiKey: process.env.RELAY_API_KEY || '',
  },
  solana: {
    rpcUrl: process.env.SOLANA_RPC_URL || '',
  },
  twitter: {
    bearerToken: process.env.TWITTER_BEARER_TOKEN || '',
  },
  opensea: {
    apiKey: process.env.OPENSEA_API_KEY || '',
  },
  reservoir: {
    apiKey: process.env.RESERVOIR_API_KEY || '',
  },
  etherscan: {
    // Optional. The holder analysis reads holders' transactions from Etherscan (v2, any chain).
    apiKey: process.env.ETHERSCAN_API_KEY || '',
  },
  holderAnalysis: {
    // Alchemy calls a sync run may make (every 10 minutes) and the gap between them.
    runCalls: parseInt(process.env.HOLDER_ANALYSIS_RUN_CALLS || '300', 10),
    callGapMs: parseInt(process.env.HOLDER_ANALYSIS_CALL_GAP_MS || '500', 10),
    txBatch: parseInt(process.env.HOLDER_ANALYSIS_TX_BATCH || '10', 10),
    openseaCalls: parseInt(process.env.HOLDER_ANALYSIS_OPENSEA_CALLS || '40', 10),
    etherscanCalls: parseInt(process.env.HOLDER_ANALYSIS_ETHERSCAN_CALLS || '100', 10),
  },
  holdings: {
    maxCollectionsPerRun: parseInt(process.env.HOLDINGS_MAX_COLLECTIONS_PER_RUN || '50', 10),
  },
});
