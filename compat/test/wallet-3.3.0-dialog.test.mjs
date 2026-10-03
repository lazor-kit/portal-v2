// @lazorkit/wallet 3.3.0 reading the portal's replies (DialogManager).
// Run with `pnpm test` in compat/.
import '../lib/page.mjs';
import { dialogCases } from '../lib/dialog-cases.mjs';

dialogCases('3.3.0', await import('wallet-3.3.0'));
