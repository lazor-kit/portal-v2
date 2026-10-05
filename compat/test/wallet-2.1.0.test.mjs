// @lazorkit/wallet 2.1.0 reading the portal's replies (DialogManager).
// Run with `pnpm test` in compat/.
import '../lib/page.mjs';
import { dialogCases } from '../lib/dialog-cases.mjs';

dialogCases('2.1.0', await import('wallet-2.1.0'));
