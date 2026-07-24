#!/usr/bin/env node
/**
 * Fetch all `PrizeClaimed` events for an Ethereum mainnet contract and write a CSV.
 *
 * The exact shape of a `PrizeClaimed` event differs from contract to contract, so
 * this script does NOT hard-code the event signature. Instead it discovers the
 * event definition from the verified contract ABI (Etherscan) or a local abi.json,
 * then derives the CSV columns dynamically from the event's parameters.
 *
 * Usage:
 *   node fetch-prizeclaimed.mjs [--address 0x...] [--out prizeclaimed.csv]
 *
 * Configuration (env vars):
 *   ETH_RPC_URL          Full JSON-RPC URL for Ethereum mainnet. Takes priority.
 *   ALCHEMY_API_KEY      If ETH_RPC_URL is unset, an Alchemy mainnet URL is built from this.
 *   ETHERSCAN_API_KEY    Optional. Used to fetch the ABI + deployment block (higher rate limit).
 *   START_BLOCK          Optional. Block to start scanning from (default: contract deploy block, else 0).
 *   END_BLOCK            Optional. Block to stop at (default: latest).
 *   CHUNK_SIZE           Optional. Blocks per getLogs request (default: 5000, auto-shrinks on error).
 *   ABI_PATH             Optional. Path to a local ABI json file (array or {abi:[...]}).
 */

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createPublicClient, http, getAbiItem, encodeEventTopics } from 'viem';
import { mainnet } from 'viem/chains';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- args -------------------------------------------------------------------
const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const ADDRESS = (getArg('address', '0x4C0B10D3bF4282609F36ae5620491F240D1af898')).toLowerCase();
const EVENT_NAME = getArg('event', 'PrizeClaimed');
const OUT = getArg('out', join(__dirname, 'prizeclaimed.csv'));
const CHUNK_SIZE_START = Number(process.env.CHUNK_SIZE || 5000);

// ---- rpc --------------------------------------------------------------------
function resolveRpcUrl() {
  if (process.env.ETH_RPC_URL) return process.env.ETH_RPC_URL;
  if (process.env.ALCHEMY_API_KEY)
    return `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;
  return null;
}

const RPC_URL = resolveRpcUrl();
if (!RPC_URL) {
  console.error(
    'ERROR: No RPC endpoint configured. Set ETH_RPC_URL or ALCHEMY_API_KEY.\n' +
      '  export ETH_RPC_URL="https://eth-mainnet.g.alchemy.com/v2/<KEY>"',
  );
  process.exit(2);
}

const client = createPublicClient({ chain: mainnet, transport: http(RPC_URL) });

// ---- helpers ----------------------------------------------------------------
// Etherscan API V2 (the V1 endpoint was deprecated). V2 is a single multichain
// endpoint that requires a `chainid` param and an API key.
const ETHERSCAN = 'https://api.etherscan.io/v2/api';
const CHAIN_ID = process.env.CHAIN_ID || '1';
const esKey = process.env.ETHERSCAN_API_KEY || '';

// Build an Etherscan V2 URL from a params object (chainid + apikey are added).
function esUrl(params) {
  const q = new URLSearchParams({ chainid: CHAIN_ID, ...params });
  if (esKey) q.set('apikey', esKey);
  return `${ETHERSCAN}?${q.toString()}`;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function loadAbi() {
  // 1) explicit local ABI file
  const localPath = process.env.ABI_PATH || join(__dirname, 'abi.json');
  if (existsSync(localPath)) {
    const raw = JSON.parse(readFileSync(localPath, 'utf8'));
    const abi = Array.isArray(raw) ? raw : raw.abi;
    if (Array.isArray(abi)) {
      console.error(`Loaded ABI from ${localPath} (${abi.length} entries).`);
      return abi;
    }
  }
  // 2) fetch verified ABI from Etherscan (V2)
  if (!esKey) {
    console.error(
      'WARNING: ETHERSCAN_API_KEY is not set. Etherscan API V2 requires a key for most requests; ' +
        'the ABI fetch will likely fail. Get a free key at https://etherscan.io/apis or supply a local abi.json.',
    );
  }
  const url = esUrl({ module: 'contract', action: 'getabi', address: ADDRESS });
  const data = await fetchJson(url);
  if (data.status !== '1') {
    throw new Error(
      `Could not fetch ABI from Etherscan (status=${data.status}, message="${data.message}", result="${data.result}"). ` +
        `Provide a local abi.json or set ABI_PATH.`,
    );
  }
  const abi = JSON.parse(data.result);
  console.error(`Loaded ABI from Etherscan (${abi.length} entries).`);
  return abi;
}

async function getDeploymentBlock() {
  if (process.env.START_BLOCK) return BigInt(process.env.START_BLOCK);
  try {
    const url = esUrl({ module: 'contract', action: 'getcontractcreation', contractaddresses: ADDRESS });
    const data = await fetchJson(url);
    if (data.status === '1' && data.result?.[0]?.blockNumber) {
      return BigInt(data.result[0].blockNumber);
    }
    if (data.result?.[0]?.txHash) {
      const receipt = await client.getTransactionReceipt({ hash: data.result[0].txHash });
      return receipt.blockNumber;
    }
  } catch (e) {
    console.error(`Deployment block lookup failed (${e.message}); starting from 0.`);
  }
  return 0n;
}

// Format a decoded value for CSV output (bigint -> decimal string, etc.).
function fmt(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.map(fmt).join(' | ');
  if (typeof v === 'object') return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
  return String(v);
}

function csvCell(s) {
  const str = String(s);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

// ---- main -------------------------------------------------------------------
async function main() {
  console.error(`Contract : ${ADDRESS}`);
  console.error(`Event    : ${EVENT_NAME}`);
  console.error(`RPC      : ${RPC_URL.replace(/\/v2\/.*/, '/v2/***')}`);

  const abi = await loadAbi();
  const eventAbi = getAbiItem({ abi, name: EVENT_NAME });
  if (!eventAbi || eventAbi.type !== 'event') {
    const events = abi.filter((x) => x.type === 'event').map((x) => x.name);
    throw new Error(`Event "${EVENT_NAME}" not found in ABI. Available events: ${events.join(', ')}`);
  }

  const params = eventAbi.inputs.map((p, i) => p.name || `arg${i}`);
  const sig = `${EVENT_NAME}(${eventAbi.inputs.map((p) => `${p.type}${p.indexed ? ' indexed' : ''} ${p.name || ''}`.trim()).join(', ')})`;
  console.error(`Signature: ${sig}`);
  console.error(`topic0   : ${encodeEventTopics({ abi: [eventAbi] })[0]}`);

  const startBlock = await getDeploymentBlock();
  const endBlock = process.env.END_BLOCK
    ? BigInt(process.env.END_BLOCK)
    : await client.getBlockNumber();
  console.error(`Scanning blocks ${startBlock} -> ${endBlock}`);

  const rows = [];
  let from = startBlock;
  const maxChunk = BigInt(CHUNK_SIZE_START);
  let chunk = maxChunk;

  while (from <= endBlock) {
    const to = from + chunk - 1n > endBlock ? endBlock : from + chunk - 1n;
    try {
      // Passing `event` makes viem build the topic0 filter AND decode the logs,
      // so only PrizeClaimed logs come back and `log.args` is already decoded.
      const logs = await client.getLogs({
        address: ADDRESS,
        event: eventAbi,
        fromBlock: from,
        toBlock: to,
      });
      for (const log of logs) {
        rows.push({
          blockNumber: log.blockNumber,
          logIndex: log.logIndex,
          transactionHash: log.transactionHash,
          transactionIndex: log.transactionIndex,
          args: log.args,
        });
      }
      if (logs.length) console.error(`  blocks ${from}-${to}: ${logs.length} event(s), total ${rows.length}`);
      from = to + 1n;
      // Recover the chunk size after a successful request so one dense range
      // doesn't force tiny queries across the whole remaining span.
      if (chunk < maxChunk) chunk = chunk * 2n > maxChunk ? maxChunk : chunk * 2n;
    } catch (e) {
      // Providers cap eth_getLogs by block range or result size; shrink and retry.
      if (chunk > 1n) {
        chunk = chunk / 2n > 0n ? chunk / 2n : 1n;
        console.error(`  blocks ${from}-${to} failed (${e.shortMessage || e.message}); retrying with chunk=${chunk}`);
        continue;
      }
      throw e;
    }
  }

  // ---- write CSV ----
  const header = ['block_number', 'transaction_hash', 'log_index', 'transaction_index', ...params];
  const lines = [header.map(csvCell).join(',')];
  for (const r of rows) {
    const argVals = params.map((name, i) => {
      const val = Array.isArray(r.args) ? r.args[i] : r.args?.[name];
      return fmt(val);
    });
    lines.push(
      [fmt(r.blockNumber), fmt(r.transactionHash), fmt(r.logIndex), fmt(r.transactionIndex), ...argVals]
        .map(csvCell)
        .join(','),
    );
  }
  writeFileSync(OUT, lines.join('\n') + '\n');
  console.error(`\nWrote ${rows.length} event(s) to ${OUT}`);
  console.error(`Columns: ${header.join(', ')}`);
}

main().catch((e) => {
  console.error(`\nFAILED: ${e.message}`);
  process.exit(1);
});
