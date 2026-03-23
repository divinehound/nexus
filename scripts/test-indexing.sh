#!/bin/bash

# Test script to trigger holder indexing
# Usage: ./scripts/test-indexing.sh <collection-id>

COLLECTION_ID=${1:-"27bc7ef8-c988-4583-af56-c2253567ebf0"}  # Default: Bored Ape

echo "🔍 Testing holder indexing for collection: $COLLECTION_ID"

# Get admin token (you'll need to provide this from your logged-in session)
# For now, we'll call the API internally via docker exec

docker exec -it $(docker ps | grep nexus-api | awk '{print $1}') \
  curl -X POST http://localhost:4000/api/admin/collections/$COLLECTION_ID/index-holders \
  -H "Content-Type: application/json" \
  2>&1

echo ""
echo "✅ Request sent!"
