// "Open in Gmail" (section 12b.5): a pre-filled compose window she sends herself. The
// dashboard never sends a pitch. Pure so the unit tests pin the exact link.

export function gmailComposeUrl(to: string, subject: string, body: string): string {
  const q = new URLSearchParams({ view: "cm", to, su: subject, body });
  return `https://mail.google.com/mail/?${q.toString().replace(/\+/g, "%20")}`;
}

/** The whole pitch as one block for the Copy button (and for pasting into an application form). */
export function pitchAsText(subject: string, body: string): string {
  return `Subject: ${subject}\n\n${body}`;
}
