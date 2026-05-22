import pool from '../config/database';
import { isFixtureFinishedForSettlement } from '../utils/matchStatus';
import { withDbRetry } from '../utils/dbRetry';

let settlementRunning = false;

function norm(s: string | null | undefined): string {
  return String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function isMatchWinnerStyleMarket(marketName: string | null | undefined): boolean {
  const n = norm(marketName);
  if (n === 'general') return true;
  return n.includes('match winner') || n === '1x2' || n.includes('full time result');
}

/** Returns true if the user's pick wins for a standard 1X2 / match-winner line. */
function pickWins(
  selection: string,
  homeLabel: string,
  awayLabel: string,
  homeScore: number,
  awayScore: number
): boolean {
  const sel = norm(selection);
  const home = norm(homeLabel);
  const away = norm(awayLabel);

  let outcome: 'home' | 'away' | 'draw';
  if (homeScore > awayScore) outcome = 'home';
  else if (awayScore > homeScore) outcome = 'away';
  else outcome = 'draw';

  if (outcome === 'draw') {
    return sel === 'draw' || sel === 'x' || sel === 'tie';
  }
  if (outcome === 'home') {
    return sel === '1' || sel === 'home' || sel === home;
  }
  return sel === '2' || sel === 'away' || sel === away;
}

type PendingSelectionRow = {
  selection_id: number;
  bet_slip_id: number;
  selection: string;
  market_name: string | null;
  home_team: string | null;
  away_team: string | null;
  status: string | null;
  minute: number;
  home_score: number;
  away_score: number;
};

/**
 * Resolve API-backed 1X2 legs from fixtures; then manual legs (no fixture row):
 * after manual_end_at, each manual leg is marked won — no live score API.
 * Slip reconciliation: any lost leg → slip lost; all won → user slips credit wallet (bet_results + balance).
 * Preset slips (is_manual_preset) mark won without paying out.
 */
export async function settlePendingBetSlips(): Promise<{
  legsUpdated: number;
  slipsReconciled: number;
  skipped?: boolean;
}> {
  if (settlementRunning) {
    return { legsUpdated: 0, slipsReconciled: 0, skipped: true };
  }
  settlementRunning = true;

  let legsUpdated = 0;
  let slipsReconciled = 0;

  try {
    const { rows } = await pool.query<PendingSelectionRow>(
      `SELECT
         bsel.id AS selection_id,
         bsel.bet_slip_id,
         bsel.selection,
         bsel.market_name,
         bsel.home_team,
         bsel.away_team,
         f.status,
         COALESCE(f.minute, 0)::int AS minute,
         COALESCE(f.home_score, 0)::int AS home_score,
         COALESCE(f.away_score, 0)::int AS away_score
       FROM bet_selections bsel
       INNER JOIN bet_slips bs ON bs.id = bsel.bet_slip_id AND bs.status = 'pending'
       INNER JOIN fixtures f ON f.id = bsel.fixture_id
       WHERE bsel.fixture_id IS NOT NULL
         AND (bsel.result IS NULL OR TRIM(bsel.result) = '')`
    );

    for (const row of rows) {
      if (!row.status || !isFixtureFinishedForSettlement(row.status, row.minute)) continue;
      if (!isMatchWinnerStyleMarket(row.market_name)) continue;

      const homeLabel = row.home_team || 'Home';
      const awayLabel = row.away_team || 'Away';
      const won = pickWins(row.selection, homeLabel, awayLabel, row.home_score, row.away_score);
      const result = won ? 'won' : 'lost';

      const upd = await pool.query(
        `UPDATE bet_selections SET result = $1 WHERE id = $2 AND (result IS NULL OR TRIM(result) = '') RETURNING id`,
        [result, row.selection_id]
      );
      if (upd.rowCount) legsUpdated += 1;
    }

    /** Manual legs (no API fixture): after scheduled end time, every leg is won — no score API. */
    const manualUpd = await pool.query(
      `UPDATE bet_selections bsel
       SET result = 'won'
       FROM bet_slips bs
       WHERE bs.id = bsel.bet_slip_id
         AND bs.status = 'pending'
         AND bsel.fixture_id IS NULL
         AND bsel.manual_end_at IS NOT NULL
         AND bsel.manual_end_at <= NOW()
         AND (bsel.result IS NULL OR TRIM(bsel.result) = '')`
    );
    legsUpdated += manualUpd.rowCount ?? 0;

    const { rows: pendingSlips } = await withDbRetry(() =>
      pool.query<{ id: number }>(
        `SELECT id FROM bet_slips WHERE status = 'pending' ORDER BY id`
      )
    );

    // ── Single shared client for all slip transactions ────────────────────
    // Acquiring pool.connect() once here (instead of once per slip) keeps
    // peak connection usage at O(1) regardless of how many slips are pending,
    // which prevents the pool from exhausting under load.
    const client = await pool.connect();
    try {
      for (const { id: slipId } of pendingSlips) {
        slipsReconciled += 1;

        const stat = await client.query<{
          total: string;
          lost: string;
          won: string;
          unsettled: string;
        }>(
          `SELECT
             COUNT(*)::text AS total,
             COUNT(*) FILTER (WHERE TRIM(COALESCE(result, '')) = 'lost')::text AS lost,
             COUNT(*) FILTER (WHERE TRIM(COALESCE(result, '')) = 'won')::text AS won,
             COUNT(*) FILTER (WHERE result IS NULL OR TRIM(result) = '')::text AS unsettled
           FROM bet_selections WHERE bet_slip_id = $1`,
          [slipId]
        );

        const total = parseInt(stat.rows[0]?.total || '0', 10);
        const lost = parseInt(stat.rows[0]?.lost || '0', 10);
        const won = parseInt(stat.rows[0]?.won || '0', 10);
        const unsettled = parseInt(stat.rows[0]?.unsettled || '0', 10);

        if (total === 0) continue;

        try {
          await client.query('BEGIN');

          const slipRes = await client.query<{
            id: number;
            user_id: number | null;
            possible_win: string;
            status: string;
            is_manual_preset: boolean | null;
          }>(
            `SELECT id, user_id, possible_win::text, status,
                    COALESCE(is_manual_preset, false) AS is_manual_preset
             FROM bet_slips WHERE id = $1 FOR UPDATE`,
            [slipId]
          );

          const slip = slipRes.rows[0];
          if (!slip || slip.status !== 'pending') {
            await client.query('COMMIT');
            continue;
          }

          if (lost > 0) {
            await client.query(
              `UPDATE bet_slips SET status = 'lost' WHERE id = $1 AND status = 'pending'`,
              [slipId]
            );
            await client.query('COMMIT');
            continue;
          }

          if (unsettled === 0 && won === total) {
            const paid = await client.query(
              `SELECT 1 FROM bet_results WHERE bet_slip_id = $1 LIMIT 1`,
              [slipId]
            );
            const isPreset = slip.is_manual_preset === true;
            if (paid.rows.length === 0 && !isPreset && slip.user_id != null) {
              const amount = parseFloat(slip.possible_win || '0');
              if (Number.isFinite(amount) && amount > 0) {
                await client.query(
                  `UPDATE wallets SET balance = balance + $1 WHERE user_id = $2`,
                  [amount, slip.user_id]
                );
                await client.query(
                  `INSERT INTO bet_results (bet_slip_id, status, win_amount, settled_at)
                   VALUES ($1, 'won', $2, NOW())`,
                  [slipId, amount]
                );
              }
            }
            await client.query(
              `UPDATE bet_slips SET status = 'won' WHERE id = $1 AND status = 'pending'`,
              [slipId]
            );
          }

          await client.query('COMMIT');
        } catch (e) {
          try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
          console.error('[BET SETTLEMENT] slip reconcile error:', slipId, e);
        }
      }
    } finally {
      client.release();
    }

    return { legsUpdated, slipsReconciled };
  } catch (e) {
    console.error('[BET SETTLEMENT] error:', e);
    return { legsUpdated, slipsReconciled: 0 };
  } finally {
    settlementRunning = false;
  }
}
