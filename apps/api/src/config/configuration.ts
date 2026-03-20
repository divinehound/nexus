export default () => ({
  port: parseInt(process.env.API_PORT || '4000', 10),
  database: {
    url: process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/nexus',
  },
  jwt: {
    secret: process.env.JWT_SECRET || 'nexus-dev-secret-change-in-production',
  },
  alchemy: {
    apiKey: process.env.ALCHEMY_API_KEY || '',
  },
  helius: {
    apiKey: process.env.HELIUS_API_KEY || '',
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
  holdings: {
    maxCollectionsPerRun: parseInt(process.env.HOLDINGS_MAX_COLLECTIONS_PER_RUN || '50', 10),
  },
});
