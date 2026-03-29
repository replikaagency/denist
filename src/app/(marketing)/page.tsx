import type { Metadata } from "next";
import {
  MessageCircle,
  Clock,
  PhoneOff,
  CheckCircle,
  CalendarCheck,
} from "lucide-react";

export const metadata: Metadata = {
  title: "Recepcionista IA para clínicas dentales | Disponible 24/7",
  description:
    "Responde dudas frecuentes, recoge solicitudes de cita y ayuda a tu equipo a no perder pacientes fuera de horario.",
};

// ─── WhatsApp config ────────────────────────────────────────────────────────
// Set NEXT_PUBLIC_WHATSAPP_PHONE (digits only, e.g. "34950123456") and
// NEXT_PUBLIC_CLINIC_NAME in your environment to customise the CTA link.
const clinicName = process.env.NEXT_PUBLIC_CLINIC_NAME ?? "la clínica";
const WA_PHONE = (process.env.NEXT_PUBLIC_WHATSAPP_PHONE ?? "34600000000").replace(/\D/g, "");
const WA_MESSAGE = encodeURIComponent(`Hola, quiero hablar con el asistente de ${clinicName}`);
const WA_LINK = `https://wa.me/${WA_PHONE}?text=${WA_MESSAGE}`;
// ────────────────────────────────────────────────────────────────────────────

function WhatsAppCTA({
  label = "Hablar por WhatsApp",
  size = "default",
  variant = "primary",
}: {
  label?: string;
  size?: "default" | "large";
  variant?: "primary" | "outline";
}) {
  const base =
    "inline-flex items-center justify-center gap-2 font-semibold rounded-xl transition-colors";
  const sizeClass =
    size === "large" ? "px-7 py-4 text-base" : "px-5 py-2.5 text-sm";
  const variantClass =
    variant === "primary"
      ? "bg-[#3ABFA0] hover:bg-[#2da98b] text-white"
      : "border border-gray-200 text-gray-600 hover:border-gray-300 hover:text-gray-800 bg-white";

  return (
    <a
      href={WA_LINK}
      target="_blank"
      rel="noopener noreferrer"
      className={`${base} ${sizeClass} ${variantClass}`}
    >
      {variant === "primary" && (
        <MessageCircle className={size === "large" ? "w-5 h-5" : "w-4 h-4"} />
      )}
      {label}
    </a>
  );
}

// ─── Nav ────────────────────────────────────────────────────────────────────
function Nav() {
  return (
    <header className="sticky top-0 z-10 bg-white border-b border-gray-100 px-5 py-4 flex items-center justify-between">
      <div className="flex items-center gap-2">
        <div className="w-7 h-7 rounded-md bg-[#4A90D9] flex items-center justify-center">
          <MessageCircle className="w-4 h-4 text-white" />
        </div>
        <span className="font-semibold text-gray-900 text-sm">DentalAI</span>
      </div>
      <WhatsAppCTA />
    </header>
  );
}

// ─── Hero ───────────────────────────────────────────────────────────────────
function Hero() {
  return (
    <section className="bg-white px-6 pt-16 pb-14 text-center">
      <p className="text-[#4A90D9] text-xs font-semibold uppercase tracking-widest mb-5">
        Recepción dental con IA
      </p>
      <h1 className="text-[2rem] font-bold text-gray-900 leading-tight mb-4 max-w-xs mx-auto">
        Un recepcionista IA para clínicas dentales, disponible 24/7
      </h1>
      <p className="text-gray-500 text-base max-w-[300px] mx-auto mb-8 leading-relaxed">
        Responde dudas frecuentes, recoge solicitudes y ayuda a tu equipo a no
        perder pacientes fuera de horario.
      </p>
      <div className="flex flex-col items-center gap-3">
        <WhatsAppCTA size="large" />
        <a
          href="#como-funciona"
          className="text-sm text-gray-400 hover:text-gray-600 transition-colors underline underline-offset-2"
        >
          Ver cómo funciona
        </a>
      </div>
    </section>
  );
}

// ─── Benefits ───────────────────────────────────────────────────────────────
function Benefits() {
  const items = [
    {
      icon: PhoneOff,
      title: "Menos llamadas perdidas",
      desc: "El asistente responde a cualquier hora. Los pacientes no se quedan sin atención.",
    },
    {
      icon: MessageCircle,
      title: "Respuestas a preguntas frecuentes",
      desc: "Precios, tratamientos, horarios. Las consultas habituales, resueltas sin que tu equipo tenga que intervenir.",
    },
    {
      icon: CalendarCheck,
      title: "Solicitudes recogidas en orden",
      desc: "Cada solicitud llega con nombre, motivo y datos de contacto. Lista para gestionar.",
    },
    {
      icon: Clock,
      title: "Activo fuera de horario",
      desc: "La clínica puede estar cerrada. El asistente no.",
    },
  ];

  return (
    <section className="bg-[#F8FAFC] px-5 py-14">
      <h2 className="text-xl font-bold text-gray-900 text-center mb-8">
        Qué hace por tu clínica
      </h2>
      <div className="space-y-4 max-w-sm mx-auto">
        {items.map((item) => (
          <div
            key={item.title}
            className="bg-white rounded-2xl p-5 flex gap-4 shadow-sm"
          >
            <div className="flex-shrink-0 w-9 h-9 rounded-xl bg-[#EBF9F6] flex items-center justify-center">
              <item.icon className="w-4 h-4 text-[#3ABFA0]" />
            </div>
            <div>
              <h3 className="font-semibold text-gray-900 text-sm mb-1">
                {item.title}
              </h3>
              <p className="text-gray-500 text-sm leading-relaxed">{item.desc}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// ─── How it works ────────────────────────────────────────────────────────────
function HowItWorks() {
  const steps = [
    {
      n: "1",
      title: "El paciente escribe",
      desc: "Por WhatsApp o por web. Sin registros ni apps nuevas.",
    },
    {
      n: "2",
      title: "El asistente responde y recoge los datos",
      desc: "Atiende la consulta, hace las preguntas necesarias y registra la solicitud.",
    },
    {
      n: "3",
      title: "La clínica revisa y gestiona",
      desc: "El equipo recibe la solicitud con toda la información y decide cómo continuar.",
    },
  ];

  return (
    <section id="como-funciona" className="bg-white px-5 py-14">
      <h2 className="text-xl font-bold text-gray-900 text-center mb-10">
        Cómo funciona
      </h2>
      <div className="max-w-sm mx-auto">
        {steps.map((step, i) => (
          <div key={step.n} className="flex gap-4">
            <div className="flex flex-col items-center">
              <div className="w-8 h-8 rounded-full bg-[#4A90D9] text-white flex items-center justify-center font-bold text-sm flex-shrink-0">
                {step.n}
              </div>
              {i < steps.length - 1 && (
                <div className="w-0.5 h-8 bg-gray-200 my-1" />
              )}
            </div>
            <div className="pb-8 pt-0.5">
              <h3 className="font-semibold text-gray-900 text-sm mb-1">
                {step.title}
              </h3>
              <p className="text-gray-500 text-sm leading-relaxed">{step.desc}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// ─── WhatsApp demo ───────────────────────────────────────────────────────────
function WhatsAppDemo() {
  const messages = [
    {
      from: "patient",
      text: "Hola, me duele mucho una muela. ¿Podéis atenderme hoy?",
    },
    {
      from: "ai",
      text: "Hola, lamento que estés así. Si el dolor es muy fuerte, te recomiendo llamar directamente a la clínica cuanto antes.",
    },
    {
      from: "ai",
      text: "Si quieres, también puedo dejar un aviso con tus datos para que el equipo lo revise.",
    },
    { from: "patient", text: "Sí, por favor." },
    {
      from: "ai",
      text: "Perfecto. ¿Me dices tu nombre y un teléfono de contacto?",
    },
    { from: "patient", text: "Soy Laura Martínez, 612 345 678" },
    {
      from: "ai",
      text: "Gracias, Laura. Si quieres, cuéntame brevemente qué te ocurre.",
    },
    {
      from: "patient",
      text: "Tengo un dolor agudo en la muela del juicio desde ayer.",
    },
    {
      from: "ai",
      text: "Anotado. El equipo lo revisa y te contacta en breve.",
    },
  ];

  return (
    <section className="bg-[#F8FAFC] px-5 py-14">
      <h2 className="text-xl font-bold text-gray-900 text-center mb-2">
        Así funciona en la práctica
      </h2>
      <p className="text-gray-400 text-sm text-center mb-8 max-w-[260px] mx-auto leading-relaxed">
        El asistente recoge la información y avisa a tu equipo. No confirma
        citas por su cuenta.
      </p>

      <div className="max-w-[320px] mx-auto rounded-3xl shadow-sm border border-gray-200 overflow-hidden">
        {/* WhatsApp-style header */}
        <div className="bg-[#075E54] px-4 py-3 flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-[#3ABFA0] flex items-center justify-center flex-shrink-0">
            <MessageCircle className="w-4 h-4 text-white" />
          </div>
          <div>
            <p className="text-white text-xs font-semibold">
              Clínica Dental · Asistente
            </p>
            <p className="text-green-300 text-[10px]">en línea</p>
          </div>
        </div>

        {/* Chat bubbles */}
        <div className="px-3 py-4 space-y-1.5 bg-[#ECE5DD]">
          {messages.map((msg, i) => (
            <div
              key={i}
              className={`flex ${msg.from === "patient" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[78%] px-3 py-2 rounded-2xl text-[11px] leading-relaxed shadow-sm ${
                  msg.from === "patient"
                    ? "bg-[#DCF8C6] text-gray-800 rounded-tr-none"
                    : "bg-white text-gray-800 rounded-tl-none"
                }`}
              >
                {msg.text}
              </div>
            </div>
          ))}
        </div>
      </div>

      <p className="text-center text-xs text-gray-400 mt-4">
        El equipo recibe el aviso con todos los datos en su panel
      </p>
    </section>
  );
}

// ─── Trust ───────────────────────────────────────────────────────────────────
function Trust() {
  const points = [
    "No confirma citas: recoge solicitudes y las reenvía a tu equipo",
    "Sin cambiar tus sistemas actuales",
    "Se adapta a tu forma de trabajar",
    "Diseñado para clínicas reales",
  ];

  return (
    <section className="bg-[#4A90D9] px-5 py-14 text-white">
      <h2 className="text-xl font-bold text-center mb-3">
        Sin promesas vacías
      </h2>
      <p className="text-blue-100 text-sm text-center mb-8 max-w-[260px] mx-auto leading-relaxed">
        Un asistente que ayuda a tu equipo. No lo reemplaza.
      </p>
      <ul className="space-y-3 max-w-xs mx-auto">
        {points.map((p) => (
          <li key={p} className="flex items-start gap-3">
            <CheckCircle className="w-4 h-4 text-[#3ABFA0] flex-shrink-0 mt-0.5" />
            <span className="text-sm text-blue-50">{p}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ─── Final CTA ───────────────────────────────────────────────────────────────
function FinalCTA() {
  return (
    <section className="bg-white px-6 py-20 text-center">
      <h2 className="text-2xl font-bold text-gray-900 mb-3 max-w-xs mx-auto leading-tight">
        Empieza a atender mejor a tus pacientes desde hoy
      </h2>
      <p className="text-gray-500 text-sm max-w-[280px] mx-auto mb-8 leading-relaxed">
        Responde dudas frecuentes, recoge solicitudes y mantén la recepción
        activa incluso fuera de horario.
      </p>
      <div className="flex flex-col items-center gap-3">
        <WhatsAppCTA size="large" />
        <WhatsAppCTA
          label="Solicitar demo"
          size="large"
          variant="outline"
        />
      </div>
    </section>
  );
}

// ─── Footer ──────────────────────────────────────────────────────────────────
function Footer() {
  return (
    <footer className="bg-gray-50 border-t border-gray-100 px-6 py-8 text-center">
      <p className="text-gray-400 text-xs">
        © {new Date().getFullYear()} DentalAI · Asistencia automatizada para
        clínicas dentales.
      </p>
    </footer>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────
export default function LandingPage() {
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <Benefits />
        <HowItWorks />
        <WhatsAppDemo />
        <Trust />
        <FinalCTA />
      </main>
      <Footer />
    </>
  );
}
