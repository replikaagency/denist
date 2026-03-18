// =============================================================================
// Database types — mirrors the Supabase schema exactly.
// Keep in sync with supabase/migrations/0001_initial_schema.sql
// For production, replace with: `supabase gen types typescript --linked`
// =============================================================================

// ---------------------------------------------------------------------------
// Enum types
// ---------------------------------------------------------------------------

export type ConversationChannel = 'web_chat' | 'sms' | 'email' | 'whatsapp';

export type ConversationStatus =
  | 'active'
  | 'waiting_human'
  | 'human_active'
  | 'resolved'
  | 'abandoned';

export type MessageRole = 'patient' | 'ai' | 'human' | 'system';

export type LeadStatus =
  | 'new'
  | 'contacted'
  | 'qualified'
  | 'appointment_requested'
  | 'booked'
  | 'lost'
  | 'disqualified';

export type AppointmentType =
  | 'new_patient'
  | 'checkup'
  | 'emergency'
  | 'whitening'
  | 'implant_consult'
  | 'orthodontic_consult'
  | 'other';

export type AppointmentRequestStatus =
  | 'pending'
  | 'confirmed'
  | 'cancelled'
  | 'no_show'
  | 'completed';

export type HandoffReason =
  | 'patient_request'
  | 'ai_escalation'
  | 'complex_query'
  | 'complaint'
  | 'emergency'
  | 'other';

// ---------------------------------------------------------------------------
// Row types (what comes back from the database)
// ---------------------------------------------------------------------------

export interface Contact {
  id: string;
  email: string | null;
  phone: string | null;
  first_name: string | null;
  last_name: string | null;
  is_new_patient: boolean;
  insurance_provider: string | null;
  session_token: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface Lead {
  id: string;
  contact_id: string;
  status: LeadStatus;
  source: string | null;
  treatment_interest: string[];
  notes: string | null;
  assigned_to: string | null;
  qualified_at: string | null;
  lost_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface Conversation {
  id: string;
  contact_id: string;
  lead_id: string | null;
  channel: ConversationChannel;
  status: ConversationStatus;
  ai_enabled: boolean;
  summary: string | null;
  last_message_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: MessageRole;
  content: string;
  model: string | null;
  tokens_used: number | null;
  finish_reason: string | null;
  latency_ms: number | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface AppointmentRequest {
  id: string;
  contact_id: string;
  conversation_id: string | null;
  lead_id: string | null;
  appointment_type: AppointmentType;
  status: AppointmentRequestStatus;
  preferred_date: string | null;
  preferred_time_of_day: string | null;
  preferred_days: string[];
  notes: string | null;
  confirmed_at: string | null;
  confirmed_datetime: string | null;
  // Reschedule audit trail (added migration 0006)
  rescheduled_from: string | null;
  rescheduled_to: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface HandoffEvent {
  id: string;
  conversation_id: string;
  contact_id: string;
  reason: HandoffReason;
  trigger_message_id: string | null;
  assigned_to: string | null;
  resolved_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Joined / view types used by route handlers
// ---------------------------------------------------------------------------

export interface ConversationWithMessages extends Conversation {
  messages: Message[];
}

export interface LeadWithContact extends Lead {
  contact: Contact;
}

export interface AppointmentRequestWithContact extends AppointmentRequest {
  contact: Contact;
}

// ---------------------------------------------------------------------------
// Supabase Database generic type
// Matches the structure required by @supabase/supabase-js createClient<Database>().
// Fields that have SQL defaults are optional in Insert; all fields are optional in Update.
// ---------------------------------------------------------------------------

type GenericRelationship = {
  foreignKeyName: string;
  columns: string[];
  isOneToOne: boolean;
  referencedRelation: string;
  referencedColumns: string[];
};

export type Database = {
  public: {
    Tables: {
      contacts: {
        Row: Contact;
        Insert: {
          id?: string;
          email?: string | null;
          phone?: string | null;
          first_name?: string | null;
          last_name?: string | null;
          is_new_patient?: boolean;
          insurance_provider?: string | null;
          session_token?: string;
          metadata?: Record<string, unknown>;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          email?: string | null;
          phone?: string | null;
          first_name?: string | null;
          last_name?: string | null;
          is_new_patient?: boolean;
          insurance_provider?: string | null;
          session_token?: string;
          metadata?: Record<string, unknown>;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: GenericRelationship[];
      };
      leads: {
        Row: Lead;
        Insert: {
          id?: string;
          contact_id: string;
          status?: LeadStatus;
          source?: string | null;
          treatment_interest?: string[];
          notes?: string | null;
          assigned_to?: string | null;
          qualified_at?: string | null;
          lost_at?: string | null;
          metadata?: Record<string, unknown>;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          contact_id?: string;
          status?: LeadStatus;
          source?: string | null;
          treatment_interest?: string[];
          notes?: string | null;
          assigned_to?: string | null;
          qualified_at?: string | null;
          lost_at?: string | null;
          metadata?: Record<string, unknown>;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: GenericRelationship[];
      };
      conversations: {
        Row: Conversation;
        Insert: {
          id?: string;
          contact_id: string;
          lead_id?: string | null;
          channel?: ConversationChannel;
          status?: ConversationStatus;
          ai_enabled?: boolean;
          summary?: string | null;
          last_message_at?: string | null;
          metadata?: Record<string, unknown>;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          contact_id?: string;
          lead_id?: string | null;
          channel?: ConversationChannel;
          status?: ConversationStatus;
          ai_enabled?: boolean;
          summary?: string | null;
          last_message_at?: string | null;
          metadata?: Record<string, unknown>;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: GenericRelationship[];
      };
      messages: {
        Row: Message;
        Insert: {
          id?: string;
          conversation_id: string;
          role: MessageRole;
          content: string;
          model?: string | null;
          tokens_used?: number | null;
          finish_reason?: string | null;
          latency_ms?: number | null;
          metadata?: Record<string, unknown>;
          created_at?: string;
        };
        Update: never;
        Relationships: GenericRelationship[];
      };
      appointment_requests: {
        Row: AppointmentRequest;
        Insert: {
          id?: string;
          contact_id: string;
          conversation_id?: string | null;
          lead_id?: string | null;
          appointment_type: AppointmentType;
          status?: AppointmentRequestStatus;
          preferred_date?: string | null;
          preferred_time_of_day?: string | null;
          preferred_days?: string[];
          notes?: string | null;
          confirmed_at?: string | null;
          confirmed_datetime?: string | null;
          rescheduled_from?: string | null;
          rescheduled_to?: string | null;
          cancelled_at?: string | null;
          cancel_reason?: string | null;
          metadata?: Record<string, unknown>;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          contact_id?: string;
          conversation_id?: string | null;
          lead_id?: string | null;
          appointment_type?: AppointmentType;
          status?: AppointmentRequestStatus;
          preferred_date?: string | null;
          preferred_time_of_day?: string | null;
          preferred_days?: string[];
          notes?: string | null;
          confirmed_at?: string | null;
          confirmed_datetime?: string | null;
          rescheduled_from?: string | null;
          rescheduled_to?: string | null;
          cancelled_at?: string | null;
          cancel_reason?: string | null;
          metadata?: Record<string, unknown>;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: GenericRelationship[];
      };
      handoff_events: {
        Row: HandoffEvent;
        Insert: {
          id?: string;
          conversation_id: string;
          contact_id: string;
          reason: HandoffReason;
          trigger_message_id?: string | null;
          assigned_to?: string | null;
          resolved_at?: string | null;
          notes?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          conversation_id?: string;
          contact_id?: string;
          reason?: HandoffReason;
          trigger_message_id?: string | null;
          assigned_to?: string | null;
          resolved_at?: string | null;
          notes?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: GenericRelationship[];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      [_ in never]: never;
    };
    Enums: {
      conversation_channel: ConversationChannel;
      conversation_status: ConversationStatus;
      message_role: MessageRole;
      lead_status: LeadStatus;
      appointment_type: AppointmentType;
      appointment_request_status: AppointmentRequestStatus;
      handoff_reason: HandoffReason;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

// ---------------------------------------------------------------------------
// Insert / Update convenience aliases — derived from Database, always in sync
// ---------------------------------------------------------------------------

export type ContactInsert = Database['public']['Tables']['contacts']['Insert'];
export type LeadInsert = Database['public']['Tables']['leads']['Insert'];
export type ConversationInsert = Database['public']['Tables']['conversations']['Insert'];
export type MessageInsert = Database['public']['Tables']['messages']['Insert'];
export type AppointmentRequestInsert = Database['public']['Tables']['appointment_requests']['Insert'];
export type HandoffEventInsert = Database['public']['Tables']['handoff_events']['Insert'];
