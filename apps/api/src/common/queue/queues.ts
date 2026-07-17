/**
 * BullMQ queue names. Every background-work path in the API goes through one
 * of these queues so jobs are durable (survive restarts), retried with
 * backoff, bounded in concurrency, and safe to run across multiple API
 * instances (Redis-backed locks).
 */
export const WALLET_INDEXING_QUEUE = 'wallet-indexing';
export const HOLDER_INDEXING_QUEUE = 'holder-indexing';
export const COLLECTION_DISCOVERY_QUEUE = 'collection-discovery';
export const HOLDER_HISTORY_SCAN_QUEUE = 'holder-history-scan';
