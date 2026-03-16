import { upsertLead, advanceLeadStatus, getLeadByContactId } from '@/lib/db/leads';
import type { Lead } from '@/types/database';

/**
 * Ensure a lead record exists for a contact.
 * Idempotent — returns existing lead if one already exists.
 */
export async function ensureLead(
  contactId: string,
  source = 'web_chat',
): Promise<Lead> {
  return upsertLead(contactId, source);
}

/**
 * Advance a lead to a new status. Handles timestamp side-effects
 * (qualified_at, lost_at) via the DB layer.
 */
export async function advanceStatus(
  contactId: string,
  newStatus: Lead['status'],
  extra?: { treatment_interest?: string[]; notes?: string },
): Promise<Lead> {
  return advanceLeadStatus(contactId, newStatus, extra);
}

/**
 * Check if a contact has an existing lead.
 */
export async function getLeadForContact(contactId: string): Promise<Lead | null> {
  return getLeadByContactId(contactId);
}
