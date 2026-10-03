// @lazorkit/wallet 2.0.1 reading the portal's replies (DialogManager).
// Run with `pnpm test` in compat/.
import '../lib/page.mjs';
import { dialogCases } from '../lib/dialog-cases.mjs';

dialogCases('2.0.1', await import('wallet-2.0.1'));
