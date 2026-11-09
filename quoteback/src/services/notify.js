import { composeNotice } from '../email/compose.js';

// Alerts the contractor. Failures are logged, never thrown, so they can't break customer-facing flows.
export async function notifyContractor(ctx, account, { subject, text, replyTo }) {
  try {
    await ctx.transport.send(composeNotice(ctx.cfg, { to: account.notify_email, subject, text, replyTo }));
    return true;
  } catch (err) {
    console.error(`[notify] account ${account.id}: ${err.message}`);
    return false;
  }
}
