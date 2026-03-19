# nexus

## API Endpoints

### Collections

- `POST /api/collections/track`
  - Request:
    ```json
    {
      "chain": "ethereum",
      "contractAddress": "0x1234567890abcdef1234567890abcdef12345678"
    }
    ```
  - Response (202):
    ```json
    {
      "statusCode": 202,
      "collectionId": "uuid",
      "status": "tracked_unverified",
      "routeHint": "/api/collections/ethereum/0x1234567890abcdef1234567890abcdef12345678"
    }
    ```

- `GET /api/collections/:chain/:contractAddress`
  - Returns tracked collection details, verification + mapping states, project/proposed project, and basic metrics placeholders.

### Admin Collections (admin auth required)

- `POST /api/admin/collections/:id/verify`
  - Body (optional):
    ```json
    {
      "projectId": "uuid",
      "notes": "Manual review complete"
    }
    ```

- `POST /api/admin/collections/:id/reject`
  - Body (optional):
    ```json
    {
      "notes": "Invalid contract metadata"
    }
    ```

- `POST /api/admin/collections/:id/suggest-project`
  - Body:
    ```json
    {
      "projectId": "uuid",
      "confidence": 0.82,
      "notes": "High overlap in holder graph"
    }
    ```
  - `confidence` must be between `0` and `1`.
