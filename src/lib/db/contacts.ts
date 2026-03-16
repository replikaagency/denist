import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { AppError } from '@/lib/errors';
import type { Contact } from '@/types/database';

const db = () => createSupabaseAdminClient();

/**
 * Find a contact by their browser session token.
 * Returns null if not found (caller decides whether to create one).
 */
export async function findContactBySessionToken(
  sessionToken: string,
): Promise<Contact | null> {
  const { data, error } = await db()
    .from('contacts')
    .select('*')
    .eq('session_token', sessionToken)
    .maybeSingle();

  if (error) throw AppError.database('Failed to look up contact', error);
  return data as Contact | null;
}

/**
 * Create a new anonymous contact with an optional session token.
 * Called when a new conversation is started.
 */
export async function createContact(insert: {
  session_token?: string;
  email?: string | null;
  phone?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  is_new_patient?: boolean;
  insurance_provider?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<Contact> {
  const { data, error } = await db()
    .from('contacts')
    .insert({
      is_new_patient: true,
      metadata: {},
      ...insert,
    })
    .select('*')
    .single();

  if (error) throw AppError.database('Failed to create contact', error);
  return data as Contact;
}

/**
 * Enrich a contact once the AI has collected their details.
 * Uses patch semantics — only provided fields are updated.
 */
export async function updateContact(
  id: string,
  patch: Partial<Omit<Contact, 'id' | 'created_at' | 'updated_at'>>,
): Promise<Contact> {
  const { data, error } = await db()
    .from('contacts')
    .update(patch)
    .eq('id', id)
    .select('*')
    .single();

  if (error) throw AppError.database('Failed to update contact', error);
  if (!data) throw AppError.notFound('Contact', id);
  return data as Contact;
}

/**
 * Find a contact by email or phone (for de-duplication before creating).
 */
export async function findContactByEmailOrPhone(
  email?: string,
  phone?: string,
): Promise<Contact | null> {
  if (!email && !phone) return null;

  const supabase = db();

  if (email) {
    const { data, error } = await supabase
      .from('contacts')
      .select('*')
      .eq('email', email)
      .maybeSingle();
    if (error) throw AppError.database('Failed to look up contact by email', error);
    if (data) return data as Contact;
  }

  if (phone) {
    const { data, error } = await supabase
      .from('contacts')
      .select('*')
      .eq('phone', phone)
      .maybeSingle();
    if (error) throw AppError.database('Failed to look up contact by phone', error);
    if (data) return data as Contact;
  }

  return null;
}

export async function getContactById(id: string): Promise<Contact> {
  const { data, error } = await db()
    .from('contacts')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) throw AppError.database('Failed to fetch contact', error);
  if (!data) throw AppError.notFound('Contact', id);
  return data as Contact;
}
