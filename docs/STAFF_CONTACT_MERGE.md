# Contact merge (duplicate phone / email)

When a patient’s message supplies a **phone or email** that already belongs to another contact row, the system treats them as a **returning patient**:

- The **session token** is moved to the **canonical** (existing) contact.
- The **conversation** is relinked to that canonical `contact_id` (see `enrichContact` + `transferSessionTokenToCanonical` in `contact.service.ts`).

## Name fields

If the canonical contact **already has** `first_name` / `last_name`, the merge **does not overwrite** them with the new name from the chat. Only **empty** fields on the canonical record are filled from the incoming patch.

**Staff implication:** If someone says “I’m called X now” but the CRM already had a name for that phone, the **display name may stay the old one** until staff updates it manually. This is intentional to avoid clobbering verified records.
