import { email, headerSafe } from "./notification-policy";
export interface ResendConfiguration { apiKey: string; from: string; replyTo: string | null }
export function resendConfiguration(env: NodeJS.ProcessEnv = process.env): ResendConfiguration | null {
  if (env.NOTIFICATION_EMAIL_ENABLED !== "true") return null;
  const address = email.safeParse(env.RESEND_FROM_EMAIL), name = env.RESEND_FROM_NAME?.trim() ?? "";
  const key = env.RESEND_API_KEY?.trim(), reply = env.RESEND_REPLY_TO ? email.safeParse(env.RESEND_REPLY_TO) : null;
  if (!address.success || !key || key.length > 512 || /\s/.test(key) || name.length > 100
    || !headerSafe(name) || /[<>"\\]/.test(name) || reply && !reply.success) return null;
  return { apiKey: key, from: name ? '"' + name + '" <' + address.data + '>' : address.data,
    replyTo: reply?.success ? reply.data : null };
}
export function notificationModuleConfiguration(env: NodeJS.ProcessEnv = process.env) {
  const configuration = resendConfiguration(env);
  // Missing/invalid transport configuration does not prevent commerce boot.
  return configuration ? [{ resolve: "@medusajs/medusa/notification", options: {
    providers: [{ resolve: "./src/modules/resend", id: "resend", options: { channels: ["email"], ...configuration } }],
  } }] : [];
}
