import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { api, ApiFailure, refreshAuth, useAuthStatus } from '../api';
import { Button, Field, Notice } from '../components/ui';
import { AuthLayout } from './Login';

export function SetupPage() {
  const { data: status } = useAuthStatus();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (status && !status.setupRequired) return <Navigate to="/login" replace />;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    if (form.get('password') !== form.get('confirm')) {
      setError("The passwords don't match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api('/auth/setup', {
        body: { displayName: form.get('displayName'), username: form.get('username'), password: form.get('password') },
      });
      await refreshAuth();
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiFailure ? err.message : "Couldn't reach Marquee.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout title="Let's set things up" subtitle="Create the admin account. You can add your family and link Plex or Pocket ID after.">
      {error && <Notice tone="error">{error}</Notice>}
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <Field label="Your name" name="displayName" autoComplete="name" placeholder="Josh" required />
        <Field label="Username" name="username" autoComplete="username" autoCapitalize="none" hint="Lowercase letters, numbers, dots or dashes." required />
        <Field label="Password" name="password" type="password" autoComplete="new-password" minLength={10} hint="At least 10 characters." required />
        <Field label="Confirm password" name="confirm" type="password" autoComplete="new-password" minLength={10} required />
        <Button type="submit" disabled={busy} className="mt-1">
          {busy ? 'Creating…' : 'Create admin account'}
        </Button>
      </form>
    </AuthLayout>
  );
}
