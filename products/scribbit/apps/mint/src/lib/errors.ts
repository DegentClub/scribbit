/** User-facing error text: what happened, and what to do. */

export class UserFacingError extends Error {
  constructor(
    message: string,
    readonly hint: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'UserFacingError';
  }
}

export function isRejection(e: unknown): boolean {
  const code = (e as { code?: string })?.code;
  if (code === 'USER_REJECTED') return true;
  const msg = String((e as Error)?.message ?? e).toLowerCase();
  return /reject|denied|cancel/.test(msg);
}

export function describeError(e: unknown): { message: string; hint: string } {
  if (e instanceof UserFacingError) return { message: e.message, hint: e.hint };
  if (isRejection(e)) return { message: 'You cancelled the request in your wallet.', hint: 'Nothing was signed or sent. Try again when you are ready.' };
  const code = (e as { code?: string })?.code;
  const msg = String((e as Error)?.message ?? e);
  switch (code) {
    case 'WALLET_NOT_INSTALLED':
      return { message: msg, hint: 'Install the extension, reload this page, and connect again.' };
    case 'UNSUPPORTED_NETWORK':
      return { message: msg, hint: 'Switch the wallet to the network shown in the header, then reconnect.' };
    case 'UNSUPPORTED_ADDRESS_TYPE':
      return { message: msg, hint: 'Choose a Native SegWit (bc1q…) or Taproot (bc1p…) account for payments.' };
    case 'ADDRESS_NOT_IN_WALLET':
      return { message: msg, hint: 'The wallet switched account. Disconnect and connect again.' };
    default:
      break;
  }
  if (/insufficient|not enough/i.test(msg)) return { message: msg, hint: 'Send more bitcoin to the payment address, or lower the fee rate, then retry the quote.' };
  if (/missingorspent|missing inputs|bad-txns/i.test(msg)) return { message: msg, hint: 'A coin this transaction spends is gone. Refresh the quote to pick new coins.' };
  if (/min relay fee|mempool min fee|fee too low|insufficient fee/i.test(msg)) return { message: msg, hint: 'Raise the fee rate and rebuild the transaction.' };
  if (/HTTP 5|unreachable|network|fetch/i.test(msg)) return { message: msg, hint: 'The service did not answer. Wait a moment and retry: nothing you signed is lost.' };
  return { message: msg, hint: 'If this keeps happening, copy the message above and contact support. Nothing is lost while a pending mint is shown.' };
}
