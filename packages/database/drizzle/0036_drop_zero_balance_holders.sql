-- collection_holders lists current holders only. The holder history scan used
-- to also write wallets that had sold out, with token_count 0, and the overlap,
-- graph and discovery queries counted them. The scan no longer does; this
-- removes the rows it left behind.
DELETE FROM "collection_holders" WHERE "token_count" <= 0;
