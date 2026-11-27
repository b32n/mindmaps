/**
 * Outbound email: one small sender over Cloudflare Email Sending, plain
 * templates, and a capture transport for tests.
 *
 * Configuration, all Worker vars (the installer writes them; docs/EMAIL.md):
 *
 *   MAIL_FROM        the address mail is sent from, on a domain onboarded to
 *                    Email Sending. Unset means email is off.
 *   MAIL_FROM_NAME   optional display name
 *   MAIL_DOMAIN      the sending domain; read by the installer, not here
 *   EMAIL            the `send_email` binding (wrangler.local.toml)
 *
 * Email being off is a normal state, not an error: `mailConfigured` is false,
 * the flows that need mail say so, and nothing throws. `sendMail` never throws
 * either: it reports.
 */

/** The part of the Workers Email Sending binding this module uses. */
export interface EmailBinding {
  send(message: {
    to: string;
    from: string | { email: string; name: string };
    subject: string;
    text: string;
    html: string;
  }): Promise<{ messageId?: string } | void>;
}

export interface MailEnv {
  EMAIL?: EmailBinding;
  MAIL_FROM?: string;
  MAIL_FROM_NAME?: string;
  /** "capture" keeps messages in R2 for the e2e suite; never set it anywhere else */
  MAIL_TRANSPORT?: string;
  ARTEFACTS?: R2Bucket;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export type MailResult = { ok: true; id?: string } | { ok: false; error: string };

const ADDRESS = /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/;

export const isCapture = (env: MailEnv) => env.MAIL_TRANSPORT === "capture";

/** Whether this instance can send mail at all. */
export function mailConfigured(env: MailEnv): boolean {
  const from = (env.MAIL_FROM ?? "").trim();
  if (!ADDRESS.test(from)) return false;
  return isCapture(env) ? !!env.ARTEFACTS : !!env.EMAIL;
}

const CAPTURE_PREFIX = "_mailcapture/";
const captureDir = (to: string) => `${CAPTURE_PREFIX}${encodeURIComponent(to.toLowerCase())}/`;

export async function sendMail(env: MailEnv, msg: MailMessage): Promise<MailResult> {
  if (!mailConfigured(env)) return { ok: false, error: "email is not configured" };
  const email = (env.MAIL_FROM ?? "").trim();
  const name = (env.MAIL_FROM_NAME ?? "").trim();
  try {
    if (isCapture(env)) {
      const key = `${captureDir(msg.to)}${Date.now()}-${crypto.randomUUID()}.json`;
      await env.ARTEFACTS!.put(key, JSON.stringify({ ...msg, from: email, at: Date.now() }));
      return { ok: true, id: key };
    }
    const res = await env.EMAIL!.send({
      to: msg.to,
      from: name ? { email, name } : email,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
    });
    return { ok: true, id: (res && "messageId" in res ? res.messageId : undefined) ?? undefined };
  } catch (err) {
    // Cloudflare errors carry a code (E_SENDER_NOT_VERIFIED, E_RATE_LIMIT_EXCEEDED...);
    // keep it, never the message body.
    const code = (err as { code?: string })?.code;
    console.error("mail send failed", code ?? "", (err as Error)?.message ?? err);
    return { ok: false, error: code ?? "send failed" };
  }
}

/** Messages captured for one recipient, newest last. Capture transport only. */
export async function capturedMail(env: MailEnv, to: string) {
  if (!isCapture(env) || !env.ARTEFACTS) return null;
  const listed = await env.ARTEFACTS.list({ prefix: captureDir(to) });
  const out: (MailMessage & { from: string; at: number })[] = [];
  for (const o of listed.objects) {
    const body = await env.ARTEFACTS.get(o.key);
    if (body) out.push(await body.json());
  }
  return out.sort((a, b) => a.at - b.at);
}

// --- templates --------------------------------------------------------------
//
// Plain on purpose: a heading, a sentence, one link, and the link spelled out so
// it can be copied when a client strips links. No images, no tracking, no
// remote fonts; real text, a language, and enough contrast to read anywhere.

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function layout(heading: string, paragraphs: string[], action: string, url: string, foot: string) {
  const text = [heading, "", ...paragraphs, "", `${action}:`, url, "", foot].join("\n");
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(heading)}</title></head>` +
    `<body style="margin:0;padding:24px;background:#ffffff;color:#1a1a1a;font:16px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif">` +
    `<main style="max-width:480px;margin:0 auto">` +
    `<h1 style="font-size:20px;margin:0 0 16px">${esc(heading)}</h1>` +
    paragraphs.map((p) => `<p style="margin:0 0 16px">${esc(p)}</p>`).join("") +
    `<p style="margin:0 0 16px"><a href="${esc(url)}" style="color:#0b57d0">${esc(action)}</a></p>` +
    `<p style="margin:0 0 16px;font-size:14px">Or copy this address into your browser:<br>${esc(url)}</p>` +
    `<p style="margin:0;font-size:14px;color:#555555">${esc(foot)}</p>` +
    `</main></body></html>`;
  return { text, html };
}

export function verificationEmail(url: string, hours: number): Omit<MailMessage, "to"> {
  const { text, html } = layout(
    "Confirm your email address",
    [
      "Confirm this address to finish setting up your mindmaps account.",
      `The link works once and expires in ${hours} hours.`,
    ],
    "Confirm email address",
    url,
    "If you didn't create a mindmaps account, ignore this message and nothing will happen.",
  );
  return { subject: "Confirm your email address", text, html };
}

export function resetEmail(url: string, minutes: number): Omit<MailMessage, "to"> {
  const { text, html } = layout(
    "Reset your password",
    [
      "Someone asked to reset the password for this mindmaps account.",
      `The link works once and expires in ${minutes} minutes. Using it signs you out everywhere.`,
    ],
    "Choose a new password",
    url,
    "If this wasn't you, ignore this message: your password has not changed.",
  );
  return { subject: "Reset your password", text, html };
}
