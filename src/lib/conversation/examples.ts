/**
 * Dental Reception AI — 10 Realistic Patient Conversations
 *
 * Each example simulates a multi-turn conversation and shows the expected
 * structured LLM output for every patient turn. These serve as:
 *   - Design validation (does the schema handle real scenarios?)
 *   - Few-shot prompt material (inject relevant examples at inference time)
 *   - Test fixtures (automated regression tests for the engine)
 *
 * Conversations cover the full spectrum: routine booking, emergencies,
 * insurance, complaints, ambiguous messages, escalation, and out-of-scope.
 */

import type { LLMTurnOutput } from "./schema";

export interface ExampleTurn {
  role: "user" | "assistant";
  content: string;
  /** Only present on assistant turns — the structured output behind the reply */
  structured?: LLMTurnOutput;
}

export interface ExampleConversation {
  id: string;
  title: string;
  description: string;
  tags: string[];
  turns: ExampleTurn[];
}

// ═══════════════════════════════════════════════════════════════════════════
// CONVERSATION 1 — Happy-path new patient booking
// ═══════════════════════════════════════════════════════════════════════════

const conv1: ExampleConversation = {
  id: "conv-001",
  title: "New patient books a cleaning",
  description:
    "A new patient arrives, asks for a cleaning, provides all info smoothly, " +
    "and the system reaches the offer_appointment stage.",
  tags: ["appointment_request", "routine", "happy_path"],
  turns: [
    { role: "user", content: "Hi there, I'd like to schedule a teeth cleaning." },
    {
      role: "assistant",
      content: "I'd be happy to help you schedule a cleaning! Have you been to our office before, or would this be your first visit?",
      structured: {
        intent: "appointment_request",
        intent_confidence: 0.95,
        secondary_intent: null,
        urgency: "routine",
        urgency_reasoning: "Routine cleaning request with no symptoms.",
        patient_fields: {},
        appointment: { service_type: "cleaning" },
        symptoms: {},
        next_action: "ask_field",
        missing_fields: ["patient.new_or_returning", "patient.full_name", "patient.phone", "appointment.preferred_date", "appointment.preferred_time"],
        escalation_reason: null,
        reply: "I'd be happy to help you schedule a cleaning! Have you been to our office before, or would this be your first visit?",
        contains_diagnosis: false,
        contains_pricing: false,
      },
    },
    { role: "user", content: "First time! I'm Maria Gonzalez." },
    {
      role: "assistant",
      content: "Welcome, Maria! What's the best phone number to reach you at?",
      structured: {
        intent: "appointment_request",
        intent_confidence: 0.96,
        secondary_intent: null,
        urgency: "routine",
        urgency_reasoning: "Continuing routine booking flow.",
        patient_fields: { full_name: "Maria Gonzalez", new_or_returning: "new" },
        appointment: {},
        symptoms: {},
        next_action: "ask_field",
        missing_fields: ["patient.phone", "appointment.preferred_date", "appointment.preferred_time"],
        escalation_reason: null,
        reply: "Welcome, Maria! What's the best phone number to reach you at?",
        contains_diagnosis: false,
        contains_pricing: false,
      },
    },
    { role: "user", content: "555-234-5678. Sometime next Tuesday morning would be great." },
    {
      role: "assistant",
      content: "Got it, Maria. Let me check what we have available next Tuesday morning and I'll get back to you with some options.",
      structured: {
        intent: "appointment_request",
        intent_confidence: 0.97,
        secondary_intent: null,
        urgency: "routine",
        urgency_reasoning: "Routine cleaning — all required fields now collected.",
        patient_fields: { phone: "555-234-5678" },
        appointment: { preferred_date: "next Tuesday", preferred_time: "morning" },
        symptoms: {},
        next_action: "offer_appointment",
        missing_fields: [],
        escalation_reason: null,
        reply: "Got it, Maria. Let me check what we have available next Tuesday morning and I'll get back to you with some options.",
        contains_diagnosis: false,
        contains_pricing: false,
      },
    },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// CONVERSATION 2 — Dental emergency (knocked-out tooth)
// ═══════════════════════════════════════════════════════════════════════════

const conv2: ExampleConversation = {
  id: "conv-002",
  title: "Parent reports child's knocked-out tooth",
  description:
    "A parent reports a knocked-out tooth. System immediately classifies as " +
    "emergency, provides first-aid guidance, collects minimal info, and escalates.",
  tags: ["emergency_report", "emergency", "escalation"],
  turns: [
    { role: "user", content: "My daughter fell off the monkey bars and her front tooth came out completely! There's blood everywhere, what do I do??" },
    {
      role: "assistant",
      content: "I'm so sorry — that must be really scary. Here's what to do right now:\n\n1. Find the tooth and hold it by the crown (white part), not the root.\n2. If you can, gently rinse it with milk and try to place it back in the socket.\n3. If you can't reinsert it, keep the tooth in a cup of milk.\n4. Apply gentle pressure to the area with a clean cloth to slow the bleeding.\n\nTime matters for saving the tooth. I'm connecting you with our emergency team right away. What's your name and phone number so we can call you back immediately?",
      structured: {
        intent: "emergency_report",
        intent_confidence: 0.99,
        secondary_intent: null,
        urgency: "emergency",
        urgency_reasoning: "Avulsed permanent tooth with active bleeding — reimplantation success decreases rapidly after 30 minutes.",
        patient_fields: {},
        appointment: { service_type: "emergency exam" },
        symptoms: {
          description: "Daughter's front tooth knocked out completely from a fall, active bleeding",
          location: "front tooth",
        },
        next_action: "escalate_emergency",
        missing_fields: ["patient.full_name", "patient.phone"],
        escalation_reason: "Avulsed tooth requires immediate clinical intervention.",
        reply: "I'm so sorry — that must be really scary. Here's what to do right now:\n\n1. Find the tooth and hold it by the crown (white part), not the root.\n2. If you can, gently rinse it with milk and try to place it back in the socket.\n3. If you can't reinsert it, keep the tooth in a cup of milk.\n4. Apply gentle pressure to the area with a clean cloth to slow the bleeding.\n\nTime matters for saving the tooth. I'm connecting you with our emergency team right away. What's your name and phone number so we can call you back immediately?",
        contains_diagnosis: false,
        contains_pricing: false,
      },
    },
    { role: "user", content: "I'm Diane Park, 555-987-1234. Please hurry!" },
    {
      role: "assistant",
      content: "Thank you, Diane. Our emergency team is being notified right now and will call you at 555-987-1234 within minutes. Keep the tooth in milk and apply pressure. You're doing great — help is on the way.",
      structured: {
        intent: "emergency_report",
        intent_confidence: 0.99,
        secondary_intent: null,
        urgency: "emergency",
        urgency_reasoning: "Continuing emergency — avulsed tooth.",
        patient_fields: { full_name: "Diane Park", phone: "555-987-1234" },
        appointment: {},
        symptoms: {},
        next_action: "escalate_emergency",
        missing_fields: [],
        escalation_reason: "Emergency protocol active — staff callback initiated.",
        reply: "Thank you, Diane. Our emergency team is being notified right now and will call you at 555-987-1234 within minutes. Keep the tooth in milk and apply pressure. You're doing great — help is on the way.",
        contains_diagnosis: false,
        contains_pricing: false,
      },
    },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// CONVERSATION 3 — Insurance inquiry → appointment
// ═══════════════════════════════════════════════════════════════════════════

const conv3: ExampleConversation = {
  id: "conv-003",
  title: "Insurance check leads to booking",
  description:
    "Patient first asks if their insurance is accepted, then transitions " +
    "into booking an appointment once confirmed.",
  tags: ["insurance_inquiry", "appointment_request", "multi_intent"],
  turns: [
    { role: "user", content: "Do you guys take Delta Dental PPO?" },
    {
      role: "assistant",
      content: "Yes, we do accept Delta Dental PPO! Would you like to schedule an appointment, or do you have questions about what your plan covers for a specific service?",
      structured: {
        intent: "insurance_inquiry",
        intent_confidence: 0.94,
        secondary_intent: null,
        urgency: "informational",
        urgency_reasoning: "Insurance coverage question with no symptoms or urgency.",
        patient_fields: { insurance_provider: "Delta Dental PPO" },
        appointment: {},
        symptoms: {},
        next_action: "provide_info",
        missing_fields: [],
        escalation_reason: null,
        reply: "Yes, we do accept Delta Dental PPO! Would you like to schedule an appointment, or do you have questions about what your plan covers for a specific service?",
        contains_diagnosis: false,
        contains_pricing: false,
      },
    },
    { role: "user", content: "Great! Yeah I'd like to book a checkup. My name is Tom Huang." },
    {
      role: "assistant",
      content: "Wonderful, Tom! Are you a new patient or have you visited us before?",
      structured: {
        intent: "appointment_request",
        intent_confidence: 0.93,
        secondary_intent: "insurance_inquiry",
        urgency: "routine",
        urgency_reasoning: "Routine checkup request following insurance confirmation.",
        patient_fields: { full_name: "Tom Huang" },
        appointment: { service_type: "checkup" },
        symptoms: {},
        next_action: "ask_field",
        missing_fields: ["patient.new_or_returning", "patient.phone", "appointment.preferred_date", "appointment.preferred_time"],
        escalation_reason: null,
        reply: "Wonderful, Tom! Are you a new patient or have you visited us before?",
        contains_diagnosis: false,
        contains_pricing: false,
      },
    },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// CONVERSATION 4 — Symptom report with urgency escalation
// ═══════════════════════════════════════════════════════════════════════════

const conv4: ExampleConversation = {
  id: "conv-004",
  title: "Toothache escalates to urgent",
  description:
    "Patient starts by describing a moderate toothache, but details reveal " +
    "swelling and fever — urgency escalates from 'soon' to 'urgent'.",
  tags: ["symptom_report", "urgent", "urgency_escalation"],
  turns: [
    { role: "user", content: "I've had a toothache for about a week now. It's getting worse." },
    {
      role: "assistant",
      content: "I'm sorry to hear that. A toothache that's been getting worse over a week definitely warrants a dental visit. On a scale of 0 to 10, how would you rate the pain right now?",
      structured: {
        intent: "symptom_report",
        intent_confidence: 0.93,
        secondary_intent: null,
        urgency: "soon",
        urgency_reasoning: "Worsening toothache over one week — no emergency signals yet, but should be seen soon.",
        patient_fields: {},
        appointment: {},
        symptoms: { description: "Toothache getting worse over about a week", duration: "about 1 week" },
        next_action: "ask_field",
        missing_fields: ["symptoms.pain_level", "symptoms.location"],
        escalation_reason: null,
        reply: "I'm sorry to hear that. A toothache that's been getting worse over a week definitely warrants a dental visit. On a scale of 0 to 10, how would you rate the pain right now?",
        contains_diagnosis: false,
        contains_pricing: false,
      },
    },
    { role: "user", content: "It's like a 7 or 8. My cheek is swollen on the left side and I had a fever last night." },
    {
      role: "assistant",
      content: "I appreciate you sharing that. Swelling combined with a fever means you should be seen as soon as possible — ideally today or tomorrow. I'd like to get you in right away. Can I get your name and phone number so we can schedule an urgent appointment?",
      structured: {
        intent: "symptom_report",
        intent_confidence: 0.95,
        secondary_intent: "appointment_request",
        urgency: "urgent",
        urgency_reasoning: "Facial swelling with fever alongside severe pain (7-8/10) suggests possible abscess — needs attention within 24 hours.",
        patient_fields: {},
        appointment: { service_type: "urgent exam" },
        symptoms: {
          pain_level: 8,
          location: "left side",
          triggers: "swelling on left cheek, fever reported",
        },
        next_action: "ask_field",
        missing_fields: ["patient.full_name", "patient.phone"],
        escalation_reason: null,
        reply: "I appreciate you sharing that. Swelling combined with a fever means you should be seen as soon as possible — ideally today or tomorrow. I'd like to get you in right away. Can I get your name and phone number so we can schedule an urgent appointment?",
        contains_diagnosis: false,
        contains_pricing: false,
      },
    },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// CONVERSATION 5 — Pricing question (guardrail: no inventing prices)
// ═══════════════════════════════════════════════════════════════════════════

const conv5: ExampleConversation = {
  id: "conv-005",
  title: "Patient asks how much a crown costs",
  description:
    "Patient asks for a specific price. System avoids inventing a number " +
    "and instead offers to help check insurance or get an estimate.",
  tags: ["pricing_inquiry", "guardrail", "informational"],
  turns: [
    { role: "user", content: "How much does a dental crown cost at your office?" },
    {
      role: "assistant",
      content: "Great question! The cost of a crown can vary depending on the material used and your specific insurance coverage. Rather than give you an inaccurate number, I'd love to help you get an accurate estimate. Do you have dental insurance? If so, we can look into what your plan covers for crowns.",
      structured: {
        intent: "pricing_inquiry",
        intent_confidence: 0.96,
        secondary_intent: null,
        urgency: "informational",
        urgency_reasoning: "Cost inquiry with no clinical symptoms.",
        patient_fields: {},
        appointment: { service_type: "crown" },
        symptoms: {},
        next_action: "ask_field",
        missing_fields: ["patient.insurance_provider"],
        escalation_reason: null,
        reply: "Great question! The cost of a crown can vary depending on the material used and your specific insurance coverage. Rather than give you an inaccurate number, I'd love to help you get an accurate estimate. Do you have dental insurance? If so, we can look into what your plan covers for crowns.",
        contains_diagnosis: false,
        contains_pricing: false,
      },
    },
    { role: "user", content: "I don't have insurance. Can you just give me a ballpark?" },
    {
      role: "assistant",
      content: "I understand wanting a rough idea before committing. Since crown costs depend on the type of crown and the specific tooth, our office can put together an estimate after a quick exam. We also offer payment plans to help make treatment affordable. Would you like to schedule a consultation so we can give you an accurate quote?",
      structured: {
        intent: "pricing_inquiry",
        intent_confidence: 0.92,
        secondary_intent: "appointment_request",
        urgency: "informational",
        urgency_reasoning: "Still a cost inquiry — no clinical urgency.",
        patient_fields: {},
        appointment: {},
        symptoms: {},
        next_action: "continue",
        missing_fields: [],
        escalation_reason: null,
        reply: "I understand wanting a rough idea before committing. Since crown costs depend on the type of crown and the specific tooth, our office can put together an estimate after a quick exam. We also offer payment plans to help make treatment affordable. Would you like to schedule a consultation so we can give you an accurate quote?",
        contains_diagnosis: false,
        contains_pricing: false,
      },
    },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// CONVERSATION 6 — Complaint → human handoff
// ═══════════════════════════════════════════════════════════════════════════

const conv6: ExampleConversation = {
  id: "conv-006",
  title: "Unhappy patient escalated to staff",
  description:
    "Patient complains about a billing issue. System empathizes, then " +
    "escalates to a human team member per escalation rules.",
  tags: ["complaint", "escalation", "human_handoff"],
  turns: [
    { role: "user", content: "I was told my cleaning was covered but now I got a bill for $180. This is unacceptable." },
    {
      role: "assistant",
      content: "I completely understand your frustration, and I'm sorry about this billing confusion. That shouldn't happen, and I want to make sure it's resolved for you. Let me connect you with our billing team right away — they'll be able to look into exactly what happened with your insurance claim and get this sorted out. One moment please.",
      structured: {
        intent: "complaint",
        intent_confidence: 0.97,
        secondary_intent: "billing_inquiry",
        urgency: "informational",
        urgency_reasoning: "Billing dispute — no clinical urgency, but emotionally urgent for the patient.",
        patient_fields: {},
        appointment: {},
        symptoms: {},
        next_action: "escalate_human",
        missing_fields: [],
        escalation_reason: "Patient complaint about unexpected billing — requires human resolution and empathy.",
        reply: "I completely understand your frustration, and I'm sorry about this billing confusion. That shouldn't happen, and I want to make sure it's resolved for you. Let me connect you with our billing team right away — they'll be able to look into exactly what happened with your insurance claim and get this sorted out. One moment please.",
        contains_diagnosis: false,
        contains_pricing: false,
      },
    },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// CONVERSATION 7 — Returning patient reschedules
// ═══════════════════════════════════════════════════════════════════════════

const conv7: ExampleConversation = {
  id: "conv-007",
  title: "Returning patient reschedules appointment",
  description:
    "A returning patient needs to move their appointment to a different day.",
  tags: ["appointment_reschedule", "routine", "returning_patient"],
  turns: [
    { role: "user", content: "Hey, I need to reschedule my appointment this Thursday. Something came up at work." },
    {
      role: "assistant",
      content: "No problem at all — things come up! Could I get your name so I can pull up your appointment?",
      structured: {
        intent: "appointment_reschedule",
        intent_confidence: 0.95,
        secondary_intent: null,
        urgency: "routine",
        urgency_reasoning: "Routine reschedule with no symptoms or urgency.",
        patient_fields: { new_or_returning: "returning" },
        appointment: {},
        symptoms: {},
        next_action: "ask_field",
        missing_fields: ["patient.full_name", "patient.phone", "appointment.preferred_date", "appointment.preferred_time"],
        escalation_reason: null,
        reply: "No problem at all — things come up! Could I get your name so I can pull up your appointment?",
        contains_diagnosis: false,
        contains_pricing: false,
      },
    },
    { role: "user", content: "It's Kevin Brooks, 555-111-2222. Can we do Monday instead, afternoon if possible?" },
    {
      role: "assistant",
      content: "Thanks, Kevin. Let me check Monday afternoon availability for you and I'll get back to you with some open times.",
      structured: {
        intent: "appointment_reschedule",
        intent_confidence: 0.97,
        secondary_intent: null,
        urgency: "routine",
        urgency_reasoning: "Standard reschedule — all info collected.",
        patient_fields: { full_name: "Kevin Brooks", phone: "555-111-2222" },
        appointment: { preferred_date: "Monday", preferred_time: "afternoon" },
        symptoms: {},
        next_action: "offer_appointment",
        missing_fields: [],
        escalation_reason: null,
        reply: "Thanks, Kevin. Let me check Monday afternoon availability for you and I'll get back to you with some open times.",
        contains_diagnosis: false,
        contains_pricing: false,
      },
    },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// CONVERSATION 8 — Ambiguous message → clarification
// ═══════════════════════════════════════════════════════════════════════════

const conv8: ExampleConversation = {
  id: "conv-008",
  title: "Vague message requires clarification",
  description:
    "Patient sends an ambiguous opening message. System asks a clarifying " +
    "question rather than guessing wrong.",
  tags: ["unknown", "fallback", "clarification"],
  turns: [
    { role: "user", content: "I need some help with my teeth" },
    {
      role: "assistant",
      content: "Of course, I'm here to help! Could you tell me a bit more about what's going on? For example, are you looking to book an appointment, do you have a question about a service, or are you experiencing a dental issue?",
      structured: {
        intent: "unknown",
        intent_confidence: 0.4,
        secondary_intent: null,
        urgency: "informational",
        urgency_reasoning: "No clinical signals — too vague to assess urgency.",
        patient_fields: {},
        appointment: {},
        symptoms: {},
        next_action: "continue",
        missing_fields: [],
        escalation_reason: null,
        reply: "Of course, I'm here to help! Could you tell me a bit more about what's going on? For example, are you looking to book an appointment, do you have a question about a service, or are you experiencing a dental issue?",
        contains_diagnosis: false,
        contains_pricing: false,
      },
    },
    { role: "user", content: "Yeah my tooth has been hurting and I think I need to come in" },
    {
      role: "assistant",
      content: "I'm sorry to hear about the pain. I'd definitely recommend getting that looked at. How long has the tooth been hurting?",
      structured: {
        intent: "symptom_report",
        intent_confidence: 0.88,
        secondary_intent: "appointment_request",
        urgency: "soon",
        urgency_reasoning: "Toothache reported but severity and duration unknown — defaults to 'soon' pending more info.",
        patient_fields: {},
        appointment: {},
        symptoms: { description: "Tooth has been hurting" },
        next_action: "ask_field",
        missing_fields: ["symptoms.duration", "symptoms.pain_level", "symptoms.location"],
        escalation_reason: null,
        reply: "I'm sorry to hear about the pain. I'd definitely recommend getting that looked at. How long has the tooth been hurting?",
        contains_diagnosis: false,
        contains_pricing: false,
      },
    },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// CONVERSATION 9 — Out-of-scope question
// ═══════════════════════════════════════════════════════════════════════════

const conv9: ExampleConversation = {
  id: "conv-009",
  title: "Patient asks unrelated medical question",
  description:
    "Patient asks about an eye prescription. System politely redirects to " +
    "dental topics.",
  tags: ["out_of_scope", "guardrail"],
  turns: [
    { role: "user", content: "Can you also help me schedule an eye exam? I think my prescription is outdated." },
    {
      role: "assistant",
      content: "I appreciate you asking, but I'm only able to help with dental-related topics — things like appointments, services, insurance, or dental concerns. For an eye exam, I'd recommend reaching out to an optometrist's office. Is there anything dental-related I can help you with today?",
      structured: {
        intent: "out_of_scope",
        intent_confidence: 0.97,
        secondary_intent: null,
        urgency: "informational",
        urgency_reasoning: "Non-dental request — no clinical urgency.",
        patient_fields: {},
        appointment: {},
        symptoms: {},
        next_action: "continue",
        missing_fields: [],
        escalation_reason: null,
        reply: "I appreciate you asking, but I'm only able to help with dental-related topics — things like appointments, services, insurance, or dental concerns. For an eye exam, I'd recommend reaching out to an optometrist's office. Is there anything dental-related I can help you with today?",
        contains_diagnosis: false,
        contains_pricing: false,
      },
    },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// CONVERSATION 10 — Post-treatment concern with provider question
// ═══════════════════════════════════════════════════════════════════════════

const conv10: ExampleConversation = {
  id: "conv-010",
  title: "Post-treatment sensitivity concern",
  description:
    "Patient had a filling placed last week and is worried about lingering " +
    "sensitivity. System collects details without diagnosing, and transitions " +
    "into booking a follow-up.",
  tags: ["post_treatment_concern", "soon", "provider_inquiry"],
  turns: [
    { role: "user", content: "Hi, I got a filling done with Dr. Patel last Tuesday and my tooth still feels really sensitive to cold. Is that normal?" },
    {
      role: "assistant",
      content: "Hi! Some sensitivity after a filling is common and can take a little while to settle down, but since it's been about a week, it would be a good idea to have Dr. Patel take a look. On a scale of 0 to 10, how would you rate the sensitivity when it happens?",
      structured: {
        intent: "post_treatment_concern",
        intent_confidence: 0.94,
        secondary_intent: null,
        urgency: "soon",
        urgency_reasoning: "Post-filling sensitivity for one week — not emergency, but warrants follow-up if it's not resolving.",
        patient_fields: {},
        appointment: { preferred_provider: "Dr. Patel" },
        symptoms: {
          description: "Sensitivity to cold after filling placed last Tuesday",
          location: "tooth that had filling",
          duration: "about 1 week",
          prior_treatment: "Filling placed by Dr. Patel last Tuesday",
          triggers: "cold",
        },
        next_action: "ask_field",
        missing_fields: ["symptoms.pain_level", "patient.full_name", "patient.phone"],
        escalation_reason: null,
        reply: "Hi! Some sensitivity after a filling is common and can take a little while to settle down, but since it's been about a week, it would be a good idea to have Dr. Patel take a look. On a scale of 0 to 10, how would you rate the sensitivity when it happens?",
        contains_diagnosis: false,
        contains_pricing: false,
      },
    },
    { role: "user", content: "Maybe a 4? It's sharp but goes away after a few seconds. I'm Aisha Bello by the way." },
    {
      role: "assistant",
      content: "Thanks, Aisha. A follow-up with Dr. Patel sounds like a good idea so she can check on the filling. What's the best phone number to reach you at, and I'll find a time that works?",
      structured: {
        intent: "post_treatment_concern",
        intent_confidence: 0.94,
        secondary_intent: "appointment_request",
        urgency: "soon",
        urgency_reasoning: "Moderate sensitivity (4/10) one week post-filling — follow-up recommended but not urgent.",
        patient_fields: { full_name: "Aisha Bello" },
        appointment: { service_type: "follow-up exam" },
        symptoms: {
          pain_level: 4,
          description: "Sharp sensitivity to cold, resolves after a few seconds",
        },
        next_action: "ask_field",
        missing_fields: ["patient.phone"],
        escalation_reason: null,
        reply: "Thanks, Aisha. A follow-up with Dr. Patel sounds like a good idea so she can check on the filling. What's the best phone number to reach you at, and I'll find a time that works?",
        contains_diagnosis: false,
        contains_pricing: false,
      },
    },
    { role: "user", content: "It's 555-777-8899. Anytime this week is fine for me." },
    {
      role: "assistant",
      content: "Perfect, Aisha. Let me check Dr. Patel's availability this week and I'll find you a slot. Hang tight!",
      structured: {
        intent: "appointment_request",
        intent_confidence: 0.93,
        secondary_intent: "post_treatment_concern",
        urgency: "soon",
        urgency_reasoning: "Follow-up for post-filling sensitivity — all fields collected.",
        patient_fields: { phone: "555-777-8899" },
        appointment: { preferred_date: "this week", flexibility: "flexible" },
        symptoms: {},
        next_action: "offer_appointment",
        missing_fields: [],
        escalation_reason: null,
        reply: "Perfect, Aisha. Let me check Dr. Patel's availability this week and I'll find you a slot. Hang tight!",
        contains_diagnosis: false,
        contains_pricing: false,
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Export all conversations
// ---------------------------------------------------------------------------

export const EXAMPLE_CONVERSATIONS: ExampleConversation[] = [
  conv1,
  conv2,
  conv3,
  conv4,
  conv5,
  conv6,
  conv7,
  conv8,
  conv9,
  conv10,
];
