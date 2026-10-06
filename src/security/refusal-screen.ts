/**
 * What a person reads when a request is not shown: what happened, in plain
 * words, and always that their passkey signed nothing. The developer-facing
 * reason (`refusal-text.ts`, which is also what the app is told) goes under
 * "For experts".
 */
import { refusalText } from './refusal-text.ts';

export interface Row {
  readonly label: string;
  readonly value: string;
}

export type RefusalKind = 'mismatch' | 'unreadable' | 'origin' | 'policy' | 'channel';

export interface RefusalScreen {
  readonly kind: RefusalKind;
  readonly hero: string;
  /** Always ends with "Your passkey signed nothing." */
  readonly sentence: string;
  readonly note: string | null;
  readonly details: readonly Row[];
  /** The reason code and the developer-facing text. */
  readonly experts: readonly Row[];
  /** Whether the header names the requester (not when the portal can't tell who it is). */
  readonly showRequester: boolean;
}

export const SIGNED_NOTHING = 'Your passkey signed nothing.';
const WHY_SHOWN: Row = { label: 'Why', value: 'LazorKit only lets your passkey sign what it can show you.' };
const WHY_IDENTIFIED: Row = { label: 'Why', value: 'LazorKit only answers sites it can identify.' };

const UNREADABLE_PROBLEM: Record<string, string> = {
  'missing-challenge': "The request didn't include anything to sign.",
  'malformed-challenge': "The data to sign isn't in a form LazorKit can read.",
  'unrecognised-format': "The app sent data LazorKit can't read as a payment, a permission or a message.",
  'payload-not-allowed': 'The request mixes kinds of data that are never signed together.',
  'connect-challenge-not-proof': "The sign-in request isn't in the standard form.",
  'credential-missing': "The request doesn't say which passkey should sign it.",
  'unknown-action': "LazorKit doesn't know what this request is asking for.",
};

/** The screen for refusal `reason`, naming the requester as `name` ("Fernway", "swap.tinydex.fun", "the app"). */
export function refusalScreen(reason: string, name: string): RefusalScreen {
  const experts: Row[] = [
    { label: 'Reason', value: reason },
    { label: 'For developers', value: refusalText(reason).detail },
  ];
  switch (reason) {
    case 'display-text-mismatch':
      return {
        kind: 'mismatch',
        hero: 'LazorKit stopped this request',
        sentence: `It didn't match what you'd approve. ${SIGNED_NOTHING}`,
        note: `If it keeps happening, contact ${name}.`,
        details: [
          { label: 'Problem', value: 'The text shown and the data to sign are different.' },
          { label: 'Your account', value: 'Nothing left your account.' },
          WHY_SHOWN,
        ],
        experts,
        showRequester: true,
      };
    case 'requester-unknown':
      return {
        kind: 'origin',
        hero: "Can't tell which site opened this",
        sentence: `So LazorKit stopped here. ${SIGNED_NOTHING}`,
        note: 'Close this and start again from the app.',
        details: [{ label: 'Still happening?', value: 'Private browsing or some privacy settings can cause this.' }, WHY_IDENTIFIED],
        experts,
        showRequester: false,
      };
    case 'requester-conflict':
      return {
        kind: 'origin',
        hero: "Can't tell which site opened this",
        sentence: `Two different sites claim to have opened it. ${SIGNED_NOTHING}`,
        note: "Start again from the app's own website.",
        details: [WHY_IDENTIFIED],
        experts,
        showRequester: false,
      };
    case 'redirect-refused':
      return {
        kind: 'origin',
        hero: "LazorKit can't send the answer back",
        sentence: `This return address isn't registered for the app. ${SIGNED_NOTHING}`,
        note: 'Start again from the app.',
        details: [{ label: 'Why', value: 'LazorKit only sends answers to addresses an app registered.' }],
        experts,
        showRequester: true,
      };
    case 'channel-unsupported':
      return {
        kind: 'channel',
        hero: "Can't answer this request",
        sentence: `LazorKit can't send an answer to where this came from. ${SIGNED_NOTHING}`,
        note: 'Start again from the app, in your browser.',
        details: [],
        experts,
        showRequester: true,
      };
    case 'requires-registered-app':
      return {
        kind: 'policy',
        hero: `${name} can't ask for this`,
        sentence: `Only verified apps can ask for this. ${SIGNED_NOTHING}`,
        note: null,
        details: [{ label: 'What to do', value: 'If you trust this site, ask it to register with LazorKit.' }, WHY_SHOWN],
        experts,
        showRequester: true,
      };
    case 'kind-denied':
      return {
        kind: 'policy',
        hero: `${name} can't ask for this`,
        sentence: `LazorKit doesn't accept this kind of request from it. ${SIGNED_NOTHING}`,
        note: null,
        details: [WHY_SHOWN],
        experts,
        showRequester: true,
      };
    default:
      return {
        kind: 'unreadable',
        hero: "LazorKit can't show this request",
        sentence: `So it stopped it. ${SIGNED_NOTHING}`,
        note: 'Older apps sometimes do this.',
        details: [{ label: 'Problem', value: UNREADABLE_PROBLEM[reason] ?? "LazorKit can't read this request." }, WHY_SHOWN],
        experts,
        showRequester: true,
      };
  }
}
