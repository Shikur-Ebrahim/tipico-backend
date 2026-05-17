/** SQL: bet_markets row is a 1X2 / match-winner market. */
export function sqlMarketIsDisplayable(bmAlias = 'bm'): string {
  const b = bmAlias;
  return `(
    LOWER(${b}.name) LIKE '%match winner%'
    OR LOWER(${b}.name) LIKE '%full time result%'
    OR LOWER(${b}.name) LIKE '%home/away%'
    OR LOWER(${b}.name) = '1x2'
    OR LOWER(${b}.name) LIKE '%3way%'
    OR LOWER(${b}.market_key) = '1x2'
    OR LOWER(${b}.market_key) LIKE '%1x2%'
    OR LOWER(${b}.market_key) LIKE '%match_winner%'
  )`;
}

/** SQL fragment: fixture has stored 1X2 / match-winner style odds (home list). */
export function sqlFixtureHasDisplayableOdds(fixtureAlias = 'f'): string {
  const f = fixtureAlias;
  return `EXISTS (
    SELECT 1 FROM odds o
    JOIN bet_markets bm ON bm.id = o.market_id
    WHERE o.fixture_id = ${f}.id
      AND o.odd_value IS NOT NULL
      AND o.odd_value > 0
      AND ${sqlMarketIsDisplayable('bm')}
  )`;
}
