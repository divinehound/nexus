# PrizeClaimed events → CSV

Fetches every `PrizeClaimed` event emitted by an Ethereum mainnet contract and
writes them to a CSV, one row per event.

Default target contract: `0x4C0B10D3bF4282609F36ae5620491F240D1af898`.

## How it works

The exact parameters of a `PrizeClaimed` event vary between contracts, so the
script does **not** hard-code a signature. It:

1. Loads the contract ABI (local `abi.json` if present, otherwise the verified
   ABI from Etherscan) and locates the `PrizeClaimed` event definition.
2. Derives the CSV columns from that event's parameters.
3. Finds the contract's deployment block (Etherscan) so it doesn't scan from 0.
4. Pages `eth_getLogs` over the block range in chunks (auto-shrinking the chunk
   size if a provider rejects an over-large range), decoding each log with viem.
5. Writes the CSV.

## Setup

```bash
cd scripts/prizeclaimed-events
npm install
```

## Run

Provide an RPC endpoint and run:

```bash
export ETH_RPC_URL="https://eth-mainnet.g.alchemy.com/v2/<YOUR_ALCHEMY_KEY>"
export ETHERSCAN_API_KEY="<optional, for ABI + deploy-block lookup>"
node fetch-prizeclaimed.mjs
```

Output is written to `prizeclaimed.csv`.

### CSV columns

```
block_number, transaction_hash, log_index, transaction_index, <one column per event parameter>
```

For example, if the event is `PrizeClaimed(address indexed winner, uint256 indexed prizeId, uint256 amount)`:

```
block_number,transaction_hash,log_index,transaction_index,winner,prizeId,amount
```

## Configuration (env vars)

| Var | Purpose |
| --- | --- |
| `ETH_RPC_URL` | Full mainnet JSON-RPC URL (takes priority). |
| `ALCHEMY_API_KEY` | Used to build an Alchemy mainnet URL if `ETH_RPC_URL` is unset. |
| `ETHERSCAN_API_KEY` | Optional. Fetches the ABI and deployment block. |
| `START_BLOCK` / `END_BLOCK` | Override the scan range. |
| `CHUNK_SIZE` | Blocks per `getLogs` request (default 5000, auto-shrinks). |
| `ABI_PATH` | Path to a local ABI json (skips the Etherscan ABI fetch). |

## CLI flags

```
--address 0x...       Target contract (default: 0x4C0B10D3bF4282609F36ae5620491F240D1af898)
--event  PrizeClaimed Event name to filter on
--out    path.csv     Output file
```

## Offline / no-key fallback

If you cannot reach Etherscan, drop the contract ABI (or just the
`PrizeClaimed` event fragment) into `abi.json` in this directory, or point
`ABI_PATH` at it, and the script will use that instead of fetching.

## Note on running inside Claude Code web sessions

This script needs outbound access to an Ethereum RPC (and, unless you supply a
local `abi.json`, to Etherscan). Sandboxed sessions whose network policy blocks
those hosts will get `403` responses from the egress proxy and cannot produce
the CSV — run it in an environment with network access and your own API keys.
