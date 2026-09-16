import { useState } from "react";
import { login, type AuthUser } from "./lib/api";

interface LoginProps {
  onSuccess: (user: AuthUser) => void;
}

export function Login({ onSuccess }: LoginProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const user = await login(email, password);
      onSuccess(user);
    } catch {
      setError("Invalid email or password.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <svg className="login-logo" viewBox="0 0 32 32" fill="none" aria-hidden>
          <rect width="32" height="32" rx="7" fill="#4F46E5" />
          <rect x="13.5" y="3" width="5" height="3" rx="1.2" fill="#fff" />
          <rect x="20.3" y="5" width="4" height="2.6" rx="1" fill="#fff" transform="rotate(45 22.3 6.3)" />
          <circle cx="16" cy="18.5" r="10" fill="none" stroke="#fff" strokeWidth="2.3" />
          <line x1="16" y1="18.5" x2="16" y2="12.5" stroke="#fff" strokeWidth="2.3" strokeLinecap="round" />
          <line x1="16" y1="18.5" x2="20" y2="18.5" stroke="#fff" strokeWidth="2.3" strokeLinecap="round" />
        </svg>
        <h1>TimeStaff</h1>
        <p className="login-subtitle">Sign in to start tracking time.</p>

        <form onSubmit={handleSubmit}>
          <label>
            Work email
            <input
              type="email"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="jane@company.com"
              required
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
            />
          </label>

          {error && <p className="login-error">{error}</p>}

          <button type="submit" className="login-submit" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
