'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { MessageSquare, Users, Calendar, Clock, LogOut } from 'lucide-react';

const NAV_ITEMS = [
  { href: '/dashboard', label: 'Conversaciones', icon: MessageSquare },
  { href: '/dashboard/leads', label: 'Prospectos', icon: Users },
  { href: '/dashboard/appointments', label: 'Citas', icon: Calendar },
  { href: '/dashboard/availability', label: 'Disponibilidad', icon: Clock },
];

export function DashboardShell({
  children,
  userEmail,
}: {
  children: React.ReactNode;
  userEmail: string;
}) {
  const pathname = usePathname();

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-50 border-b bg-background">
        <div className="flex h-14 items-center gap-4 px-6">
          <div className="flex items-center gap-2">
            <div className="flex size-7 items-center justify-center rounded-md bg-primary text-[11px] font-bold text-primary-foreground">
              ✦
            </div>
            <span className="text-sm font-semibold tracking-tight">Recepción</span>
          </div>

          <nav className="ml-6 flex items-center gap-1">
            {NAV_ITEMS.map((item) => {
              const isActive =
                item.href === '/dashboard'
                  ? pathname === '/dashboard' || pathname.startsWith('/dashboard/conversations')
                  : pathname.startsWith(item.href);

              return (
                <Link key={item.href} href={item.href}>
                  <Button
                    variant={isActive ? 'secondary' : 'ghost'}
                    size="sm"
                    className="gap-1.5 text-xs"
                  >
                    <item.icon className="size-3.5" />
                    {item.label}
                  </Button>
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <span className="text-xs text-muted-foreground">{userEmail}</span>
            <form action="/api/auth/logout" method="POST">
              <Button variant="ghost" size="sm" type="submit" className="gap-1.5 text-xs">
                <LogOut className="size-3.5" />
                Cerrar sesión
              </Button>
            </form>
          </div>
        </div>
      </header>

      <main className="flex-1 bg-muted/40 p-6">{children}</main>
    </div>
  );
}
