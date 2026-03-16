import {
  findContactBySessionToken,
  createContact,
  updateContact,
  findContactByEmailOrPhone,
} from '@/lib/db/contacts';
import type { Contact } from '@/types/database';
import type { PatientFields } from '@/lib/conversation/schema';

/**
 * Resolve or create a contact by session token.
 * If the token doesn't match an existing contact, creates a new anonymous one.
 */
export async function resolveContact(sessionToken: string): Promise<Contact> {
  const existing = await findContactBySessionToken(sessionToken);
  if (existing) return existing;

  return createContact({ session_token: sessionToken });
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
  if (fields.phone) patch.phone = fields.phone;
  if (fields.email) patch.email = fields.email;
  if (fields.insurance_provider) patch.insurance_provider = fields.insurance_provider;
  if (fields.new_or_returning !== undefined && fields.new_or_returning !== null) {
    patch.is_new_patient = fields.new_or_returning === 'new';
  }

  if (Object.keys(patch).length === 0) return null;

  const duplicate = await findContactByEmailOrPhone(
    patch.email as string | undefined,
    patch.phone as string | undefined,
  );
  if (duplicate && duplicate.id !== contactId) return null;

  return updateContact(contactId, patch);
}

export { findContactBySessionToken };
