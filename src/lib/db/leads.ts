import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { AppError } from '@/lib/errors';
import type { Lead, LeadStatus, LeadWithContact } from '@/types/database';

const db = () => createSupabaseAdminClient();

/**
 * Create a lead for a contact.
 * Called automatically when a contact is first identified.
 */
export async function createLead(insert: {
  contact_id: string;
  source?: string | null;
  treatment_interest?: string[];
  notes?: string | null;
  assigned_to?: string | null;
  qualified_at?: string | null;
  lost_at?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<Lead> {
  const { data, error } = await db()
    .from('leads')
    .insert({
      status: 'new',
      treatment_interest: [],
      metadata: {},
      ...insert,
    })
    .select('*')
    .single();

  if (error) throw AppError.database('Failed to create lead', error);
  return data as Lead;
}

/**
 * Find the lead for a given contact.
 */
export async function getLeadByContactId(contactId: string): Promise<Lead | null> {
  const { data, error } = await db()
    .from('leads')
    .select('*')
    .eq('contact_id', contactId)
    .maybeSingle();

  if (error) throw AppError.database('Failed to fetch lead', error);
  return data as Lead | null;
}

export async function getLeadById(id: string): Promise<Lead> {
  const { data, error } = await db()
    .from('leads')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) throw AppError.database('Failed to fetch lead', error);
  if (!data) throw AppError.notFound('Lead', id);
  return data as Lead;
}

export async function updateLead(
  id: string,
  patch: Partial<Omit<Lead, 'id' | 'contact_id' | 'created_at' | 'updated_at'>>,
): Promise<Lead> {
  const { data, error } = await db()
    .from('leads')
    .update(patch)
    .eq('id', id)
    .select('*')
    .single();

  if (error) throw AppError.database('Failed to update lead', error);
  if (!data) throw AppError.notFound('Lead', id);
  return data as Lead;
}

export async function advanceLeadStatus(
  contactId: string,
  status: LeadStatus,
  extra?: Partial<Pick<Lead, 'treatment_interest' | 'notes' | 'qualified_at' | 'lost_at'>>,
): Promise<Lead> {
  const patch: Record<string, unknown> = { status, ...extra };

  if (status === 'qualified' && !patch['qualified_at']) {
    patch['qualified_at'] = new Date().toISOString();
  }
  if ((status === 'lost' || status === 'disqualified') && !patch['lost_at']) {
    patch['lost_at'] = new Date().toISOString();
  }

  const { data, error } = await db()
    .from('leads')
    .update(patch)
    .eq('contact_id', contactId)
    .select('*')
    .single();

  if (error) throw AppError.database('Failed to advance lead status', error);
  if (!data) throw AppError.notFound('Lead for contact', contactId);
  return data as Lead;
}

/**
 * List leads with optional status filter, joined with contact details.
 */
export async function listLeads(params: {
  status?: LeadStatus;
  assigned_to?: string;
  limit: number;
  offset: number;
}): Promise<{ leads: LeadWithContact[]; total: number }> {
  let query = db()
    .from('leads')
    .select('*, contact:contacts(*)', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(params.offset, params.offset + params.limit - 1);

  if (params.status) query = query.eq('status', params.status);
  if (params.assigned_to) query = query.eq('assigned_to', params.assigned_to);

  const { data, error, count } = await query;

  if (error) throw AppError.database('Failed to list leads', error);
  return { leads: (data ?? []) as LeadWithContact[], total: count ?? 0 };
}

/**
 * Ensure a lead exists for a contact — creates one if missing.
 */
export async function upsertLead(
  contactId: string,
  source = 'web_chat',
): Promise<Lead> {
  const existing = await getLeadByContactId(contactId);
  if (existing) return existing;
  return createLead({ contact_id: contactId, source });
}
