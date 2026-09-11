import { ImapFlow } from "imapflow";
import PostalMime from "postal-mime";
import { supabase } from "./supabase.js";
import { config } from "./config.js";
import { log } from "./log.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type MailboxRow = {
  id: string;
  email: string;
  imap_host: string;
  imap_port: number | null;
  imap_tls: boolean | null;
  inbox_uid_cursor: number | null;
  status: string;
};

export type MailSyncResult = {
  mailbox_id: string;
  inserted: number;
  cursor: number;
  error?: string;
};

let activeSync: Promise<MailSyncResult[]> | null = null;
let pollTimer: NodeJS.Timeout | null = null;
let firstPollTimer: NodeJS.Timeout | null = null;

function clean(value: unknown, max = 20_000): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}

function normalizeSubject(subject: string | null | undefined): string {
  return (subject ?? "")
    .replace(/^\s*((re|fw|fwd|aw|wg)\s*:\s*)+/gi, "")
    .trim()
    .toLowerCase()
    .slice(0, 500);
}

function messageIds(value: unknown): string[] {
  if (!value) return [];
  const raw = Array.isArray(value) ? value.join(" ") : String(value);
  const bracketed = raw.match(/<[^>]+>/g);
  return (bracketed ?? raw.split(/\s+/)).map((v) => v.trim()).filter(Boolean).slice(-100);
}

function addresses(value: unknown): Array<{ name?: string; email: string }> {
  const input = Array.isArray(value) ? value : value ? [value] : [];
  const output: Array<{ name?: string; email: string }> = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    if (Array.isArray(item.group)) {
      output.push(...addresses(item.group));
      continue;
    }
    const email = clean(item.address ?? item.email, 500)?.toLowerCase();
    if (email && EMAIL_RE.test(email)) {
      const name = clean(item.name, 500);
      output.push(name ? { name, email } : { email });
    }
  }
  return output;
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 180) || "attachment";
}

async function getMailboxPassword(mailboxId: string): Promise<string> {
  const { data, error } = await supabase.rpc("mailbox_secret_get", { _mailbox_id: mailboxId });
  if (error) throw new Error(`Mailbox-Secret konnte nicht gelesen werden: ${error.message}`);
  const password = clean(data, 5000);
  if (!password) throw new Error("Mailbox-Zugangsdaten fehlen");
  return password;
}

async function findLead(email: string | null) {
  if (!email) return null;
  const { data } = await supabase
    .from("leads")
    .select("id,lifecycle_stage")
    .ilike("email", email)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

async function findOrCreateThread(
  mailboxId: string,
  leadId: string | null,
  subject: string,
  inReplyTo: string | null,
  references: string[],
): Promise<{ threadId: string; leadId: string | null }> {
  const ids = [inReplyTo, ...references].filter((v): v is string => Boolean(v));
  if (ids.length) {
    const { data } = await supabase
      .from("mail_messages")
      .select("thread_id,lead_id")
      .eq("mailbox_id", mailboxId)
      .in("internet_message_id", ids)
      .not("thread_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data?.thread_id) {
      return { threadId: String(data.thread_id), leadId: (data.lead_id as string | null) ?? leadId };
    }
  }

  const normalized = normalizeSubject(subject);
  if (leadId) {
    const { data } = await supabase
      .from("mail_threads")
      .select("id")
      .eq("mailbox_id", mailboxId)
      .eq("lead_id", leadId)
      .eq("normalized_subject", normalized)
      .neq("status", "archived")
      .order("last_message_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data?.id) return { threadId: String(data.id), leadId };
  }

  const { data, error } = await supabase
    .from("mail_threads")
    .insert({
      mailbox_id: mailboxId,
      lead_id: leadId,
      subject,
      normalized_subject: normalized,
      participants: [],
      status: "open",
    })
    .select("id")
    .single();
  if (error) throw new Error(`Mail-Thread konnte nicht erstellt werden: ${error.message}`);
  return { threadId: String(data.id), leadId };
}

async function storeAttachments(
  messageId: string,
  mailboxId: string,
  input: Array<Record<string, unknown>>,
): Promise<void> {
  const rows: Array<Record<string, unknown>> = [];
  for (const attachment of input.slice(0, 30)) {
    const fileName = clean(attachment.filename, 500) ?? "Anhang";
    const content = attachment.content;
    const bytes = content instanceof Uint8Array
      ? content
      : content instanceof ArrayBuffer
        ? new Uint8Array(content)
        : null;
    let storagePath: string | null = null;

    if (bytes && bytes.byteLength <= 25 * 1024 * 1024) {
      const path = `${mailboxId}/${messageId}/${crypto.randomUUID()}-${safeFileName(fileName)}`;
      const { error } = await supabase.storage.from("mail-attachments").upload(path, bytes, {
        contentType: clean(attachment.mimeType, 250) ?? "application/octet-stream",
        upsert: false,
      });
      if (!error) storagePath = path;
      else log.warn("Mail-Anhang konnte nicht gespeichert werden", { file: fileName, error: error.message });
    }

    rows.push({
      message_id: messageId,
      file_name: fileName,
      content_type: clean(attachment.mimeType, 250),
      size_bytes: bytes?.byteLength ?? null,
      storage_path: storagePath,
      content_id: clean(attachment.contentId, 500),
      inline: attachment.disposition === "inline" || attachment.related === true,
    });
  }

  if (rows.length) {
    const { error } = await supabase.from("mail_attachments").insert(rows);
    if (error) throw new Error(`Anhang-Metadaten konnten nicht gespeichert werden: ${error.message}`);
  }
}

async function markInboundLead(leadId: string | null, receivedAt: string, internetMessageId: string): Promise<void> {
  if (!leadId) return;
  const { data: lead } = await supabase.from("leads").select("lifecycle_stage").eq("id", leadId).maybeSingle();
  const update: Record<string, unknown> = { last_contact_at: receivedAt };
  if (!lead?.lifecycle_stage || ["prospect", "qualified", "contacted"].includes(String(lead.lifecycle_stage))) {
    update.lifecycle_stage = "replied";
  }
  await supabase.from("leads").update(update).eq("id", leadId);
  await supabase
    .from("mail_sequence_enrollments")
    .update({ status: "stopped_reply", stopped_at: receivedAt, stop_reason: "inbound_reply", next_send_at: null })
    .eq("lead_id", leadId)
    .eq("status", "active");
  await supabase.from("lead_events").insert({
    lead_id: leadId,
    type: "mail_received",
    actor_label: "Mail-Center",
    payload: { message_id: internetMessageId },
  });
}

async function storeRawMessage(
  box: MailboxRow,
  uid: number,
  source: Uint8Array,
  internalDate?: Date,
): Promise<boolean> {
  const providerUid = `INBOX:${uid}`;
  const { data: uidMatch } = await supabase
    .from("mail_messages")
    .select("id")
    .eq("mailbox_id", box.id)
    .eq("folder", "inbox")
    .eq("provider_uid", providerUid)
    .maybeSingle();
  if (uidMatch?.id) return false;

  const parsed = await PostalMime.parse(source);
  const internetMessageId = clean(parsed.messageId, 1000) ?? `<imap-${box.id}-${uid}@czarina.local>`;
  const { data: messageMatch } = await supabase
    .from("mail_messages")
    .select("id,provider_uid")
    .eq("mailbox_id", box.id)
    .eq("internet_message_id", internetMessageId)
    .maybeSingle();
  if (messageMatch?.id) {
    if (!messageMatch.provider_uid) {
      await supabase.from("mail_messages").update({ provider_uid: providerUid }).eq("id", messageMatch.id);
    }
    return false;
  }

  const from = addresses(parsed.from)[0] ?? { email: box.email.toLowerCase() };
  const to = addresses(parsed.to);
  const cc = addresses(parsed.cc);
  const bcc = addresses(parsed.bcc);
  const lead = await findLead(from.email);
  const refs = messageIds(parsed.references);
  const inReplyTo = clean(parsed.inReplyTo, 1000);
  const thread = await findOrCreateThread(box.id, lead?.id ?? null, parsed.subject ?? "", inReplyTo, refs);

  const headerDate = parsed.date ? new Date(parsed.date) : null;
  const receivedAt = headerDate && !Number.isNaN(headerDate.getTime())
    ? headerDate.toISOString()
    : internalDate?.toISOString() ?? new Date().toISOString();

  const { data: row, error } = await supabase
    .from("mail_messages")
    .insert({
      thread_id: thread.threadId,
      mailbox_id: box.id,
      lead_id: thread.leadId,
      direction: "inbound",
      folder: "inbox",
      status: "received",
      provider_uid: providerUid,
      internet_message_id: internetMessageId,
      in_reply_to: inReplyTo,
      reference_message_ids: refs,
      from_address: from.email,
      from_name: from.name ?? null,
      to_addresses: to,
      cc_addresses: cc,
      bcc_addresses: bcc,
      reply_to: addresses(parsed.replyTo)[0]?.email ?? null,
      subject: parsed.subject ?? "",
      body_text: clean(parsed.text, 200_000),
      body_html: clean(parsed.html, 500_000),
      received_at: receivedAt,
      metadata: { synced_from_imap: true, imap_folder: "INBOX", worker: "hetzner" },
    })
    .select("id")
    .single();
  if (error) throw new Error(`E-Mail konnte nicht gespeichert werden: ${error.message}`);

  await supabase.from("mail_threads").update({ last_message_at: receivedAt, lead_id: thread.leadId }).eq("id", thread.threadId);
  if (Array.isArray(parsed.attachments) && parsed.attachments.length) {
    await storeAttachments(String(row.id), box.id, parsed.attachments as Array<Record<string, unknown>>);
  }
  await markInboundLead(thread.leadId, receivedAt, internetMessageId);
  return true;
}

async function syncOneMailbox(box: MailboxRow): Promise<MailSyncResult> {
  const password = await getMailboxPassword(box.id);
  const client = new ImapFlow({
    host: box.imap_host,
    port: Number(box.imap_port ?? 993),
    secure: box.imap_tls !== false,
    auth: { user: box.email, pass: password },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });

  let cursor = Number(box.inbox_uid_cursor ?? 0);
  let inserted = 0;
  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX", { readOnly: true });
    try {
      const opened = client.mailbox;
      if (!opened) throw new Error("INBOX konnte nicht geöffnet werden");
      const exists = opened.exists ?? 0;
      if (exists > 0) {
        let range: string | null = null;
        if (cursor > 0) {
          const uidNext = opened.uidNext ?? cursor + 1;
          if (uidNext > cursor + 1) {
            const lastUid = Math.min(uidNext - 1, cursor + 50);
            range = `${cursor + 1}:${lastUid}`;
          }
        } else {
          const startSequence = Math.max(1, exists - 9);
          range = `${startSequence}:*`;
        }

        if (range) {
          const messages = await client.fetchAll(range, { uid: true, source: true, internalDate: true }, cursor > 0 ? { uid: true } : undefined);
          for (const message of messages) {
            const uid = Number(message.uid ?? 0);
            if (!uid || !message.source) continue;
            const internalDate = message.internalDate instanceof Date
              ? message.internalDate
              : message.internalDate
                ? new Date(message.internalDate)
                : undefined;
            try {
              if (await storeRawMessage(box, uid, message.source, internalDate)) inserted += 1;
              cursor = Math.max(cursor, uid);
            } catch (error) {
              const text = error instanceof Error ? error.message : String(error);
              log.error("IMAP-Nachricht konnte nicht importiert werden", { mailbox: box.email, uid, error: text });
              throw error;
            }
          }
        }
      }
    } finally {
      lock.release();
    }
    await client.logout();

    const now = new Date().toISOString();
    await supabase
      .from("mailboxes")
      .update({ status: "connected", last_error: null, last_sync_at: now, inbox_uid_cursor: cursor || null })
      .eq("id", box.id);
    log.info("Mail-Sync abgeschlossen", { mailbox: box.email, inserted, cursor });
    return { mailbox_id: box.id, inserted, cursor };
  } catch (error) {
    try { await client.logout(); } catch { /* ignore */ }
    const text = error instanceof Error ? error.message : String(error);
    await supabase.from("mailboxes").update({ status: "error", last_error: text.slice(0, 2000) }).eq("id", box.id);
    log.error("Mail-Sync fehlgeschlagen", { mailbox: box.email, error: text });
    return { mailbox_id: box.id, inserted, cursor, error: text };
  }
}

async function runSync(mailboxId?: string | null): Promise<MailSyncResult[]> {
  let query = supabase
    .from("mailboxes")
    .select("id,email,imap_host,imap_port,imap_tls,inbox_uid_cursor,status")
    .neq("status", "disabled");
  if (mailboxId) query = query.eq("id", mailboxId);
  const { data, error } = await query;
  if (error) throw new Error(`Mailboxen konnten nicht geladen werden: ${error.message}`);
  const results: MailSyncResult[] = [];
  for (const box of data ?? []) results.push(await syncOneMailbox(box as MailboxRow));
  return results;
}

export async function syncMailboxes(mailboxId?: string | null): Promise<MailSyncResult[]> {
  if (activeSync) return activeSync;
  activeSync = runSync(mailboxId).finally(() => { activeSync = null; });
  return activeSync;
}

export async function authorizeMailUser(token: string): Promise<boolean> {
  if (!token) return false;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return false;
  const { data: roles } = await supabase.from("user_roles").select("role").eq("user_id", data.user.id);
  return (roles ?? []).some((row) => ["admin", "mitarbeiter"].includes(String(row.role)));
}

export function startMailPolling(): void {
  if (pollTimer) return;
  const execute = () => {
    void syncMailboxes().catch((error) => {
      log.error("Periodischer Mail-Sync fehlgeschlagen", { error: error instanceof Error ? error.message : String(error) });
    });
  };
  firstPollTimer = setTimeout(execute, 5_000);
  pollTimer = setInterval(execute, config.mailPollIntervalMs);
  pollTimer.unref();
  firstPollTimer.unref();
  log.info("Mail-Poller gestartet", { interval_ms: config.mailPollIntervalMs });
}

export function stopMailPolling(): void {
  if (pollTimer) clearInterval(pollTimer);
  if (firstPollTimer) clearTimeout(firstPollTimer);
  pollTimer = null;
  firstPollTimer = null;
}
