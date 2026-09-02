import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "../icons";

const BUSY_ACCOUNT_STATUSES = new Set([
  "loading",
  "restoring",
  "signingin",
  "signingup",
  "resending",
]);

function normalizedStatus(status) {
  return typeof status === "string" ? status.toLowerCase().replace(/[^a-z]/g, "") : "";
}

function messageFrom(value) {
  if (typeof value === "string") return value.trim();
  return value instanceof Error || (value && typeof value === "object")
    ? String(value.message || "").trim()
    : "";
}

function safeAuthError(error, action) {
  const message = messageFrom(error).toLowerCase();

  if (/email.*not.*confirm|not.*confirm.*email/.test(message)) {
    return "Confirm your email before signing in. Check your inbox or resend the confirmation.";
  }
  if (/rate.?limit|too many|request.*limit/.test(message)) {
    return "Too many attempts. Wait a few minutes and try again.";
  }
  if (/network|failed to fetch|fetch failed|offline|connection/.test(message)) {
    return "We couldn’t reach the account service. Data on this device was not changed.";
  }
  if (/password.*(short|weak|length)|weak.*password/.test(message)) {
    return "Use a stronger password with at least 8 characters.";
  }
  if (/invalid.*email|email.*invalid/.test(message)) {
    return "Enter a valid email address.";
  }

  if (action === "signin") return "Email or password is incorrect.";
  if (action === "signup") {
    return "We couldn’t create the account. Check the details and try again. If this email already has an account, sign in instead.";
  }
  if (action === "resend") return "We couldn’t resend the confirmation email. Wait a moment and try again.";
  return "The account service could not complete that request. Try again.";
}

function safeAccountNotice(notice) {
  const message = messageFrom(notice);
  if (!message) return "";

  const normalized = message.toLowerCase();
  if (/invalid login|invalid credential|user not found|wrong password/.test(normalized)) {
    return "Email or password is incorrect.";
  }
  if (/already registered|already exists|user.*exists/.test(normalized)) {
    return "If this email can be used, confirmation instructions were sent.";
  }
  if (/postgres|\bsql\b|row.level security|\brls\b|service.role|stack trace/.test(normalized)) {
    return "The account service could not complete that request. Try again.";
  }
  return message;
}

function noticeTone(notice) {
  if (!notice || typeof notice !== "object") return "notice";
  return ["error", "warning"].includes(String(notice.type || notice.kind || "").toLowerCase())
    ? "error"
    : "notice";
}

export default function CloudAccountGate({ account, localProfiles = [], onUseLocal, productName = "Semester Board", productDescription = "Use one private account to keep your semester board available across your devices.", privacyDescription = "Dashboard state, assistant histories, and syllabus files sync to private Supabase storage for this account. Notification permission and subscription, AI consent, and Study Deck session and selected media stay on this device." }) {
  const [mode, setMode] = useState("signin");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [confirmationEmail, setConfirmationEmail] = useState("");
  const [pendingAction, setPendingAction] = useState("");
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const titleId = useId();
  const errorId = useId();
  const gateRef = useRef(null);
  const firstFieldRef = useRef(null);

  const configured = account?.configured !== false;
  const accountBusy = BUSY_ACCOUNT_STATUSES.has(normalizedStatus(account?.status));
  const busy = Boolean(pendingAction) || accountBusy;
  const publicNotice = safeAccountNotice(account?.notice);
  const publicNoticeTone = noticeTone(account?.notice);

  useEffect(() => {
    setError("");
    setFeedback("");
    setPassword("");
    setPasswordConfirmation("");
  }, [mode]);

  useLayoutEffect(() => {
    if (gateRef.current) {
      gateRef.current.scrollTop = 0;
      gateRef.current.scrollLeft = 0;
    }
    firstFieldRef.current?.focus({ preventScroll: true });
  }, [mode]);

  const chooseMode = (nextMode) => {
    if (busy) return;
    setMode(nextMode);
  };

  const handleSignIn = async (event) => {
    event.preventDefault();
    if (busy || !configured) return;

    setPendingAction("signin");
    setError("");
    setFeedback("");
    try {
      await account.signIn({ email: email.trim(), password });
    } catch (caught) {
      setError(safeAuthError(caught, "signin"));
    } finally {
      setPendingAction("");
    }
  };

  const handleSignUp = async (event) => {
    event.preventDefault();
    if (busy || !configured) return;
    if (password !== passwordConfirmation) {
      setError("The passwords do not match.");
      return;
    }

    const normalizedEmail = email.trim();
    setPendingAction("signup");
    setError("");
    setFeedback("");
    try {
      const result = await account.signUp({
        displayName: displayName.trim(),
        email: normalizedEmail,
        password,
      });
      if (result?.confirmationRequired !== false) {
        setConfirmationEmail(normalizedEmail);
        setMode("confirmation");
      }
    } catch (caught) {
      setError(safeAuthError(caught, "signup"));
    } finally {
      setPendingAction("");
    }
  };

  const handleResend = async () => {
    if (busy || !configured || !confirmationEmail) return;

    setPendingAction("resend");
    setError("");
    setFeedback("");
    try {
      await account.resendConfirmation(confirmationEmail);
      setFeedback("Confirmation email sent. Check spam or junk if it doesn’t arrive.");
    } catch (caught) {
      setError(safeAuthError(caught, "resend"));
    } finally {
      setPendingAction("");
    }
  };

  const localProfileAction = localProfiles.length && typeof onUseLocal === "function" ? (
    <button className="profile-gate-secondary" disabled={busy} onClick={onUseLocal} type="button">
      Open a device-only profile
    </button>
  ) : null;

  return (
    <main className="profile-gate" aria-labelledby={titleId} ref={gateRef}>
      <section className="profile-gate-card">
        <header className="profile-gate-brand">
          <span className="profile-gate-mark"><Icon name="lock" size={26} /></span>
          <div>
            <h1 id={titleId}>{productName}</h1>
            <p>{productName}</p>
          </div>
        </header>

        <div className="profile-gate-copy">
          <h2>
            {mode === "signin"
              ? `Sign in to ${productName}`
              : mode === "create"
                ? "Create your account"
                : "Check your email"}
          </h2>
          <p>
            {mode === "confirmation"
              ? `We sent a confirmation link to ${confirmationEmail}. Open it to finish creating your account.`
              : productDescription}
          </p>
        </div>

        {!configured ? (
          <p className="profile-gate-error" role="alert">
            <Icon name="warning" size={16} />Cloud accounts are unavailable in this build. Open a device-only profile if one is saved here.
          </p>
        ) : null}

        {publicNotice ? (
          <p
            className={publicNoticeTone === "error" ? "profile-gate-error" : "profile-gate-notice"}
            role={publicNoticeTone === "error" ? "alert" : "status"}
          >
            <Icon name={publicNoticeTone === "error" ? "warning" : "info"} size={16} />{publicNotice}
          </p>
        ) : null}

        {mode !== "confirmation" ? (
          <div className="profile-gate-modes" aria-label="Cloud account actions" role="group">
            <button aria-pressed={mode === "signin"} disabled={busy} onClick={() => chooseMode("signin")} type="button">Sign in</button>
            <button aria-pressed={mode === "create"} disabled={busy} onClick={() => chooseMode("create")} type="button">Create account</button>
          </div>
        ) : null}

        {mode === "signin" ? (
          <form className="profile-gate-form" onSubmit={handleSignIn}>
            <label>
              <span>Email</span>
              <input
                aria-describedby={error ? errorId : undefined}
                aria-invalid={Boolean(error)}
                autoComplete="email"
                disabled={!configured || busy}
                inputMode="email"
                ref={firstFieldRef}
                required
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <label>
              <span>Password</span>
              <input
                aria-describedby={error ? errorId : undefined}
                aria-invalid={Boolean(error)}
                autoComplete="current-password"
                disabled={!configured || busy}
                required
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            {error ? <p className="profile-gate-error" id={errorId} role="alert"><Icon name="warning" size={16} />{error}</p> : null}
            <div className="profile-gate-actions">
              <button className="profile-gate-primary" disabled={!configured || busy || !email.trim() || !password} type="submit">
                {pendingAction === "signin" ? "Signing in…" : "Sign in"}
              </button>
              {localProfileAction}
            </div>
          </form>
        ) : mode === "create" ? (
          <form className="profile-gate-form" onSubmit={handleSignUp}>
            <label>
              <span>Display name</span>
              <input
                aria-describedby={error ? errorId : undefined}
                aria-invalid={Boolean(error)}
                autoComplete="name"
                disabled={!configured || busy}
                maxLength="40"
                placeholder="Example: Alex"
                ref={firstFieldRef}
                required
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </label>
            <label>
              <span>Email</span>
              <input
                aria-describedby={error ? errorId : undefined}
                aria-invalid={Boolean(error)}
                autoComplete="email"
                disabled={!configured || busy}
                inputMode="email"
                required
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <label>
              <span>Password</span>
              <input
                aria-describedby={`cloud-password-help${error ? ` ${errorId}` : ""}`}
                aria-invalid={Boolean(error)}
                autoComplete="new-password"
                disabled={!configured || busy}
                minLength="8"
                required
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <small id="cloud-password-help">Use at least 8 characters.</small>
            </label>
            <label>
              <span>Confirm password</span>
              <input
                aria-describedby={error ? errorId : undefined}
                aria-invalid={Boolean(error)}
                autoComplete="new-password"
                disabled={!configured || busy}
                minLength="8"
                required
                type="password"
                value={passwordConfirmation}
                onChange={(event) => setPasswordConfirmation(event.target.value)}
              />
            </label>
            {error ? <p className="profile-gate-error" id={errorId} role="alert"><Icon name="warning" size={16} />{error}</p> : null}
            <div className="profile-gate-actions">
              <button
                className="profile-gate-primary"
                disabled={!configured || busy || !displayName.trim() || !email.trim() || !password || !passwordConfirmation}
                type="submit"
              >
                {pendingAction === "signup" ? "Creating account…" : "Create account"}
              </button>
              {localProfileAction}
            </div>
          </form>
        ) : (
          <section className="profile-gate-empty profile-gate-confirmation" aria-live="polite">
            <span><Icon name="message" size={22} /></span>
            <div>
              <h3>Confirm {confirmationEmail}</h3>
              <p>After confirmation, return here and sign in. No browser data has been uploaded yet.</p>
            </div>
            {feedback ? <p className="profile-gate-notice" role="status"><Icon name="check" size={16} />{feedback}</p> : null}
            {error ? <p className="profile-gate-error" id={errorId} role="alert"><Icon name="warning" size={16} />{error}</p> : null}
            <div className="profile-gate-actions">
              <button className="profile-gate-primary" disabled={!configured || busy} onClick={handleResend} ref={firstFieldRef} type="button">
                {pendingAction === "resend" ? "Sending…" : "Resend confirmation"}
              </button>
              <button className="profile-gate-secondary" disabled={busy} onClick={() => chooseMode("signin")} type="button">Back to sign in</button>
            </div>
            <button className="profile-gate-secondary" disabled={busy} onClick={() => chooseMode("create")} type="button">Use a different email</button>
            {localProfileAction}
          </section>
        )}

        <aside className="profile-gate-privacy">
          <Icon name="shield" size={18} />
          <p><strong>Cloud account.</strong> {privacyDescription}</p>
        </aside>
      </section>
    </main>
  );
}
