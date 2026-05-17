import { ensureBetSlipSchema } from './ensureBetSlipSchema';

/** @deprecated Use ensureBetSlipSchema — kept for imports. */
export async function ensureManualPresetSchema(): Promise<void> {
  await ensureBetSlipSchema();
}
