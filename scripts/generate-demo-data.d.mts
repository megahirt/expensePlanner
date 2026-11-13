/** Types for generate-demo-data.mjs, so the demo test can import it. */

export interface DemoAccountFlow {
  label: string;
  rows: number;
  /** Total money out, in cents, as the generator intended it. */
  outCents: number;
  /** Total money in, in cents. */
  inCents: number;
  lowestBalanceCents?: number;
}

export interface DemoManifest {
  year: number;
  accounts: Record<string, DemoAccountFlow>;
  amazon: {
    orders: number;
    faceValueCents: number;
    cancelled: number;
    purchaseLinks: number;
    chargedToAmex: number;
    ambiguousPurchaseLinks: number;
    explicitRefunds: Array<{ order: string; cents: number }>;
    refundSettlements: Array<{ order: string; cents: number }>;
    unsettledReturns: string[];
  };
  totalRows: number;
}

export const DEMO_YEAR: number;
export const DEMO_DIR: string;
export const DEMO_ACCOUNTS: Array<{ file: string; label: string }>;
export const DEMO_AMAZON_FILE: string;
export function generateDemoData(): { files: Record<string, string>; manifest: DemoManifest };
