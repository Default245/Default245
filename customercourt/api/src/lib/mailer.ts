// Outbound email stub. Swap for a real provider (SES/Postmark/Resend) when
// deliverability work starts; everything upstream only depends on this shape.
export interface OutboundEmail {
  to: string;
  subject: string;
  body: string;
}

export async function sendEmail(email: OutboundEmail): Promise<void> {
  console.log(
    `[mailer:stub] to=${email.to} subject=${JSON.stringify(email.subject)} (${email.body.length} chars)`,
  );
}
