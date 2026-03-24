import {
  findContactBySessionToken,
  findContactByPhone,
  findContactByEmail,
  createContact,
  updateContact,
  findContactByEmailOrPhone,
  transferSessionTokenToCanonical,
} from '@/lib/db/contacts';
import { normalizePhone } from '@/lib/phone';
import type { Contact } from '@/types/database';
import type { PatientFields } from '@/lib/conversation/schema';

/**
 * Discriminated union of contact identifiers per channel.
 * TypeScript enforces that the correct identifier field is present for
 * each channel — you cannot construct { channel: 'whatsapp' } without phone.
 *
 * Note: the whatsapp and sms branches in resolveContact are correct code
 * but cannot succeed at the DB level until contacts.session_token is made
 * nullable (Phase 2). They are gated by the DB constraint intentionally.
 */
export type ContactIdentifier =
  | { channel: 'web_chat';  session_token: string }
  | { channel: 'whatsapp';  phone: string }
  | { channel: 'sms';       phone: string }
  | { channel: 'email';     email: string };

/**
 * Resolve or create a contact by channel identifier.
 * The web_chat path is identical to the previous behaviour.
 * Other channel paths are ready but DB-gated until Phase 2.
 */
export async function resolveContact(identifier: ContactIdentifier): Promise<Contact> {
  switch (identifier.channel) {
    case 'web_chat': {
      const existing = await findContactBySessionToken(identifier.session_token);
      if (existing) return existing;
      return createContact({ session_token: identifier.session_token });
    }
    case 'whatsapp':
    case 'sms': {
      const normalizedPhone = normalizePhone(identifier.phone);
      const existing = await findContactByPhone(normalizedPhone);
      if (existing) return existing;
      return createContact({ phone: normalizedPhone });
    }
    case 'email': {
      const normalizedEmail = identifier.email.toLowerCase().trim();
      const existing = await findContactByEmail(normalizedEmail);
      if (existing) return existing;
      return createContact({ email: normalizedEmail });
    }
  }
}

/**
 * Enrich a contact with newly extracted patient fields from the conversation engine.
 * Handles de-duplication: if another contact already owns the email/phone, returns null.
 * Only writes fields that have non-null values.
 */
export async function enrichContact(
  contactId: string,
  fields: Partial<PatientFields>,
): Promise<Contact | null> {
  const patch: Record<string, unknown> = {};

  if (fields.full_name) {
    const parts = fields.full_name.trim().split(/\s+/);
    patch.first_name = parts[0];
    if (parts.length > 1) patch.last_name = parts.slice(1).join(' ');
  }
  if (fields.phone) patch.phone = normalizePhone(fields.phone);
  if (fields.email) patch.email = fields.email.toLowerCase().trim();
  if (fields.insurance_provider) patch.insurance_provider = fields.insurance_provider;
  if (fields.new_or_returning !== undefined && fields.new_or_returning !== null) {
    patch.is_new_patient = fields.new_or_returning === 'new';
  }

  if (Object.keys(patch).length === 0) return null;

  const duplicate = await findContactByEmailOrPhone(
    patch.email as string | undefined,
    patch.phone as string | undefined,
  );
  if (duplicate && duplicate.id !== contactId) {
    // Returning patient: a canonical contact already owns this phone/email.
    // Merge only fields that are null on the canonical record — never overwrite
    // first/last name if the canonical already has them (see docs/STAFF_CONTACT_MERGE.md).
    const mergeFields: Record<string, unknown> = {};
    if (!duplicate.first_name && patch.first_name) mergeFields.first_name = patch.first_name;
    if (!duplicate.last_name && patch.last_name) mergeFields.last_name = patch.last_name;
    if (!duplicate.insurance_provider && patch.insurance_provider)
      mergeFields.insurance_provider = patch.insurance_provider;
    const canonical =
      Object.keys(mergeFields).length > 0
        ? await updateContact(duplicate.id, mergeFields)
        : duplicate;
    await transferSessionTokenToCanonical(contactId, duplicate.id);
    return canonical; // caller re-links the conversation to this canonical contact
  }

  return updateContact(contactId, patch);
}

export { findContactBySessionToken };
