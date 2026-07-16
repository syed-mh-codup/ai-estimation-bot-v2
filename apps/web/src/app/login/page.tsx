'use client';

import { signIn } from 'next-auth/react';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input, FieldLabel } from '@/components/ui/input';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    const result = await signIn('credentials', {
      email,
      password,
      redirect: false,
    });
    if (result?.error) {
      // Say what happened and what to do next. No apology, no blame.
      setError('That email and password don’t match an account. Check both and try again.');
      setLoading(false);
    } else {
      router.push('/dashboard');
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-5 py-10">
      <div className="w-full max-w-[380px]">
        {/* ── the wordmark: the first line of the document ─────────────────── */}
        <div className="text-center">
          <h1 className="font-serif text-[30px] leading-tight font-medium tracking-[-0.015em] text-ink">
            AI Estimation
          </h1>
          <p className="mt-1.5 text-[13px] text-ink-3">
            Scoped, priced and signed off in one place.
          </p>
        </div>

        <div className="mt-6 rounded-[10px] border border-line bg-surface p-6 sm:p-7">
          {error && (
            <p
              role="alert"
              className="mb-5 rounded-md border border-brick-line bg-brick-tint px-3 py-2.5 text-[12.5px] leading-relaxed text-brick"
            >
              {error}
            </p>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <FieldLabel htmlFor="email">Email</FieldLabel>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                placeholder="you@company.com"
              />
            </div>
            <div>
              <FieldLabel htmlFor="password">Password</FieldLabel>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
              />
            </div>
            <Button type="submit" size="lg" full disabled={loading} className="mt-1">
              {loading ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        </div>

        <p className="mt-5 text-center text-[11.5px] text-ink-4">
          Codup · internal estimation ledger
        </p>
      </div>
    </main>
  );
}
