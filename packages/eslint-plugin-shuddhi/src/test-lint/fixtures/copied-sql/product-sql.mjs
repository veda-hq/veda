// Fixture for `no-copied-production-sql`: a reduced stand-in for a production
// module whose SQL a parity test copied as its own expectation. The rule's
// RuleTester cases import it as `./product-sql.mjs` from this directory.

export const SEARCH_LIKE_SQL = `
  SELECT p.skuId,
    CASE
      WHEN p.normalized_sku LIKE ? ESCAPE '\\' OR p.skuId LIKE ? ESCAPE '\\' THEN 0
      WHEN p.skuName LIKE ? ESCAPE '\\' THEN 2
      ELSE 4
    END AS search_tier
  FROM Product p
  WHERE p.deleted_at IS NULL AND (
    p.normalized_sku LIKE ? ESCAPE '\\' OR p.skuName LIKE ? ESCAPE '\\'
  )
  ORDER BY search_tier, p.skuId COLLATE BINARY
  LIMIT 50
`;

export const SEARCH_FTS_SQL = `
  WITH matched AS (
    SELECT rowid FROM product_fts WHERE product_fts MATCH ?
  )
  SELECT p.skuId FROM matched m JOIN Product p ON p.rowid = m.rowid
  WHERE p.deleted_at IS NULL
  ORDER BY p.skuId COLLATE BINARY
  LIMIT 50
`;
