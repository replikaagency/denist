import { ChatUI } from "@/components/chat/chat-ui";

export const metadata = {
  title: "Patient Chat · Dental Reception AI",
  description: "Habla con nuestra recepcionista virtual.",
};

export default function ChatPage() {
  return (
    <div className="flex min-h-screen flex-col bg-muted/40">
      <header className="border-b bg-background px-6 py-3">
        <div className="mx-auto flex max-w-5xl items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="flex size-7 items-center justify-center rounded-md bg-primary text-[11px] font-bold text-primary-foreground">
              DR
            </div>
            <span className="text-sm font-semibold tracking-tight">Dental Reception AI</span>
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-4 py-8">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-bold tracking-tight">Chat con la clínica</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Nuestro asistente virtual puede ayudarte a solicitar cita, resolver dudas y más.
          </p>
        </div>

        <div className="flex-1" style={{ height: "calc(100vh - 16rem)" }}>
          <ChatUI />
        </div>
      </main>
    </div>
  );
}
