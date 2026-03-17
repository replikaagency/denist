'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardFooter } from '@/components/ui/card';

export function LoginForm({ redirectTo }: { redirectTo?: string }) {
  const [loading, setLoading] = useState(false);

  return (
    <Card>
      <form action="/api/auth/login" method="POST">
        <CardContent className="space-y-4 pt-6">
          <input type="hidden" name="redirect" value={redirectTo ?? '/dashboard'} />

          <div className="space-y-2">
            <label htmlFor="email" className="text-sm font-medium">
              Email
            </label>
            <Input
              id="email"
              name="email"
              type="email"
              placeholder="staff@brightsmile.com"
              required
              autoComplete="email"
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="password" className="text-sm font-medium">
              Password
            </label>
            <Input
              id="password"
              name="password"
              type="password"
              placeholder="••••••••"
              required
              autoComplete="current-password"
            />
          </div>
        </CardContent>

        <CardFooter>
          <Button type="submit" className="w-full" disabled={loading} onClick={() => setLoading(true)}>
            {loading ? 'Signing in…' : 'Sign in'}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
