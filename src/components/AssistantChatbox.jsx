import { useEffect, useRef, useState } from "react";
import { Icon } from "../icons";
import { CAMPUS_TIME_ZONE } from "../lib/format";

const LOCAL_MODE = "local";
const CLOUD_MODE = "cloud";

const PRIVATE_PROMPTS = [
  "What’s next?",
  "What’s due?",
  "Show my exams",
  "How is my attendance?",
];

const CHAT_STARTERS = [
  "Help me plan this week.",
  "What should I prioritize today?",
  "I’m feeling behind—help me choose one task.",
  "Talk me through my upcoming exams.",
];

const PUSH_BUSY_PHASES = new Set(["enabling", "syncing", "testing", "disabling"]);

const CAMPUS_MOMENT = new Intl.DateTimeFormat("en-US", {
  timeZone: CAMPUS_TIME_ZONE,
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const MESSAGE_TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: CAMPUS_TIME_ZONE,
  hour: "numeric",
  minute: "2-digit",
});

function formatMoment(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Time unavailable" : CAMPUS_MOMENT.format(date);
}

function formatMessageTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : MESSAGE_TIME.format(date);
}

function ChatMessage({ message }) {
  const isWaiting = message.role === "assistant" && !message.body;
  return (
    <li className={`agent-chat-message is-${message.role} ${isWaiting ? "is-streaming" : ""}`}>
      <div className="agent-chat-message-meta">
        <span>{message.role === "assistant" ? <Icon name="spark" size={13} /> : null}{message.title}</span>
        <time dateTime={message.createdAt}>{formatMessageTime(message.createdAt)}</time>
      </div>
      {isWaiting ? (
        <p aria-label="Semester Board is responding" className="agent-chat-typing" role="status">
          <span aria-hidden="true"><i /><i /><i /></span>
          Thinking…
        </p>
      ) : <p>{message.body}</p>}
    </li>
  );
}

function ModeSwitch({ mode, onSelect }) {
  return (
    <div aria-label="Assistant mode" className="agent-chat-mode-switch" role="group">
      <button
        aria-pressed={mode === CLOUD_MODE}
        className={mode === CLOUD_MODE ? "is-active" : ""}
        onClick={() => onSelect(CLOUD_MODE)}
        type="button"
      >
        <Icon name="spark" size={12} />Chat
      </button>
      <button
        aria-pressed={mode === LOCAL_MODE}
        className={mode === LOCAL_MODE ? "is-active" : ""}
        onClick={() => onSelect(LOCAL_MODE)}
        type="button"
      >
        <Icon name="lock" size={12} />Private lookup
      </button>
    </div>
  );
}

function AlertControl({ isOpen, onToggle, push }) {
  const isBlocked = push.permission === "denied" || push.phase === "blocked";
  const label = push.enabled
    ? "Reminders on"
    : isBlocked
      ? "Alerts blocked"
      : "Reminders";

  return (
    <button
      aria-controls="agent-chat-reminder-controls"
      aria-expanded={isOpen}
      className={`agent-chat-alert-status ${push.enabled ? "is-on" : ""} ${isBlocked ? "is-muted" : ""}`}
      onClick={onToggle}
      type="button"
    >
      <Icon name="bell" size={13} />{label}
    </button>
  );
}

function ReminderControls({ onClose, push, syncMode }) {
  const isBusy = PUSH_BUSY_PHASES.has(push.phase);
  const isBlocked = push.permission === "denied" || push.phase === "blocked";
  const isUnsupported = push.permission === "unsupported" || push.phase === "unsupported";

  return (
    <section
      aria-busy={isBusy}
      aria-label="Closed-tab reminder settings"
      className="agent-chat-reminder-panel"
      id="agent-chat-reminder-controls"
    >
      <div className="agent-chat-reminder-heading">
        <span><Icon name="bell" size={15} /></span>
        <p>
          <strong>Closed-tab reminders</strong>
          <small>{push.enabled ? `${push.scheduledCount} scheduled on this device` : "Optional browser notifications"}</small>
        </p>
        <button aria-label="Close reminder settings" onClick={onClose} type="button"><Icon name="close" size={14} /></button>
      </div>

      <p className="agent-chat-reminder-privacy">
        Enabling asks for notification permission, then sends this browser’s push subscription (a secret capability) plus opaque reminder IDs, types, and times over HTTPS. Closed-tab banners use generic copy; the subscription and permission stay on this device{syncMode === "cloud" ? ", while board details remain in your private account" : " inside this device-only profile"}.
      </p>

      {isBlocked ? (
        <div className="agent-chat-permission-help" role="alert">
          <strong>Notifications are blocked.</strong>
          <span>Use the icon beside the address bar → Site settings → Notifications → Allow, then reload.</span>
        </div>
      ) : null}

      {isUnsupported ? (
        <div className="agent-chat-permission-help is-muted" role="status">
          This browser cannot safely coordinate closed-tab push. In-dashboard reminders still work while the page is open.
        </div>
      ) : null}

      {push.notice ? (
        <div className="agent-chat-reminder-notice" role="status">
          <span>{push.notice}</span>
          <button aria-label="Dismiss reminder notice" onClick={() => push.setNotice(null)} type="button"><Icon name="close" size={12} /></button>
        </div>
      ) : null}

      <div className="agent-chat-reminder-actions">
        {push.enabled ? (
          <>
            <button disabled={isBusy} onClick={push.sendTest} type="button">
              {push.phase === "testing" ? "Sending test…" : "Send test"}
            </button>
            <button className="is-secondary" disabled={isBusy} onClick={push.disable} type="button">
              {push.phase === "disabling" ? "Turning off…" : "Turn off"}
            </button>
          </>
        ) : isBlocked ? (
          <button onClick={push.showPermissionHelp} type="button">Show unblock steps</button>
        ) : (
          <button disabled={isBusy || isUnsupported} onClick={push.enable} type="button">
            {isBusy ? "Setting up…" : push.phase === "error" ? "Try again" : "Enable reminders"}
          </button>
        )}
      </div>
    </section>
  );
}

function CloudConsentState({ actionRef, cloud, onUsePrivate }) {
  if (cloud.status === "ready" || cloud.status === "streaming") return null;

  if (cloud.status === "unavailable") {
    return (
      <li className="agent-chat-consent is-unavailable">
        <span><Icon name="warning" size={20} /></span>
        <div>
          <strong>Semester Chat is unavailable</strong>
          <p>Conversational chat is unavailable right now. Private board lookups still work on this device.</p>
          {cloud.error ? <small role="alert">{cloud.error}</small> : null}
          <div className="agent-chat-consent-actions">
            <button onClick={() => cloud.checkConsent({ force: true })} ref={actionRef} type="button">Try again</button>
            <button className="is-secondary" onClick={onUsePrivate} type="button">Use private lookup</button>
          </div>
        </div>
      </li>
    );
  }

  if (cloud.status === "checking" || cloud.status === "idle") {
    return (
      <li aria-live="polite" className="agent-chat-consent is-checking">
        <span><Icon name="spark" size={20} /></span>
        <div><strong>Checking Semester Chat…</strong><p>Nothing is shared until you review and accept the data notice.</p></div>
      </li>
    );
  }

  return (
    <li className="agent-chat-consent">
      <span><Icon name="shield" size={20} /></span>
      <div>
        <strong>Make Semester Board conversational</strong>
        <p>
          Semester Chat sends the messages in this Chat conversation plus a minimized board snapshot to the configured cloud AI provider: course names, class times and rooms, upcoming work and exams, aggregate attendance counts, and reminder times. Study Deck can create private extractive practice cards entirely in this browser. Only when Conversational AI is enabled and you explicitly approve Study Deck generation are bounded text excerpts and file names from that course’s selected sources sent to the configured provider; original files are never sent.
        </p>
        <small>Your profile name and passphrase, raw attendance check-ins or notes, Canvas IDs and links, uploaded syllabus files, instructor contacts, push subscription, and Private lookup history are never included. Semester Chat is automated and cannot act outside this chat. Consent lasts up to 8 hours and can be revoked anytime.</small>
        {cloud.error ? <small className="is-error" role="alert">{cloud.error}</small> : null}
        <button onClick={cloud.grantConsent} ref={actionRef} type="button">I understand · Start Semester Chat</button>
      </div>
    </li>
  );
}

export default function AssistantChatbox({ assistant }) {
  const [isOpen, setIsOpen] = useState(false);
  const [mode, setMode] = useState(CLOUD_MODE);
  const [draft, setDraft] = useState("");
  const [confirmationAction, setConfirmationAction] = useState(null);
  const [isReminderSettingsOpen, setIsReminderSettingsOpen] = useState(false);
  const [seenCount, setSeenCount] = useState(() => (
    assistant.messages.length + assistant.cloud.messages.length
  ));
  const inputRef = useRef(null);
  const launcherRef = useRef(null);
  const logRef = useRef(null);
  const panelRef = useRef(null);
  const cloudActionRef = useRef(null);
  const shouldFollowLogRef = useRef(true);
  const { cloud, push } = assistant;
  const isCloud = mode === CLOUD_MODE;
  const visibleMessages = isCloud ? cloud.messages : assistant.messages;
  const totalMessageCount = assistant.messages.length + cloud.messages.length;
  const lastMessageBody = visibleMessages.at(-1)?.body || "";
  const nextReminder = assistant.upcomingReminders.find((reminder) => !reminder.delivered) || null;
  const unreadCount = isOpen ? 0 : Math.max(0, totalMessageCount - seenCount);
  const cloudCanSend = cloud.status === "ready";
  const isComposerDisabled = isCloud && !cloudCanSend;

  useEffect(() => {
    if (!isOpen || mode !== CLOUD_MODE) return;
    cloud.checkConsent();
  }, [cloud.checkConsent, isOpen, mode]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const frame = window.requestAnimationFrame(() => {
      if (!isComposerDisabled) inputRef.current?.focus();
      else if (isCloud && ["needs-consent", "unavailable"].includes(cloud.status)) {
        cloudActionRef.current?.focus();
      } else panelRef.current?.focus();
      if (logRef.current) {
        logRef.current.scrollTop = logRef.current.scrollHeight;
        shouldFollowLogRef.current = true;
      }
    });
    const closeOnEscape = (event) => {
      if (event.key !== "Escape") return;
      setConfirmationAction(null);
      setIsReminderSettingsOpen(false);
      setIsOpen(false);
      window.requestAnimationFrame(() => launcherRef.current?.focus());
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [cloud.status, isCloud, isComposerDisabled, isOpen]);

  useEffect(() => {
    if (!isOpen) return undefined;
    setSeenCount(totalMessageCount);
    if (!shouldFollowLogRef.current) return undefined;
    const frame = window.requestAnimationFrame(() => {
      if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isOpen, lastMessageBody, mode, totalMessageCount, visibleMessages.length]);

  const openChat = () => setIsOpen(true);
  const closeChat = () => {
    setConfirmationAction(null);
    setIsReminderSettingsOpen(false);
    setSeenCount(totalMessageCount);
    setIsOpen(false);
    window.requestAnimationFrame(() => launcherRef.current?.focus());
  };

  const selectMode = (nextMode) => {
    setMode(nextMode);
    setDraft("");
    setConfirmationAction(null);
    shouldFollowLogRef.current = true;
  };

  const send = (event) => {
    event?.preventDefault();
    const clean = draft.trim();
    if (!clean || isComposerDisabled) return;
    shouldFollowLogRef.current = true;
    if (isCloud) cloud.sendMessage(clean);
    else assistant.sendMessage(clean);
    setDraft("");
  };

  const ask = (prompt) => {
    shouldFollowLogRef.current = true;
    if (isCloud) cloud.sendMessage(prompt);
    else assistant.sendMessage(prompt);
    inputRef.current?.focus();
  };

  const requestHistoryAction = (action) => {
    setConfirmationAction((current) => (current === action ? null : action));
  };

  const confirmHistoryAction = () => {
    if (confirmationAction === "revoke") cloud.revokeConsent();
    else if (isCloud) cloud.clearMessages();
    else assistant.clearMessages();
    shouldFollowLogRef.current = true;
    setConfirmationAction(null);
  };

  const trackLogPosition = () => {
    const log = logRef.current;
    if (!log) return;
    shouldFollowLogRef.current = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
  };

  const composerPlaceholder = isCloud
    ? cloud.status === "streaming"
      ? "Semester Board is responding…"
      : cloud.status === "ready"
        ? "Talk with Semester Board…"
        : "Review the chat data notice first"
    : "Look up a board fact privately…";
  const historyActionLabel = isCloud ? "Clear Chat" : "Clear Private lookup";
  const confirmationLabel = confirmationAction === "revoke"
    ? "Revoke consent and erase this Chat conversation?"
    : `Clear ${isCloud ? "Chat" : "Private lookup"} history?`;

  return (
    <div className={`agent-chatbox ${isOpen ? "is-open" : ""}`}>
      {isOpen ? (
        <section
          aria-label="Semester Board chat"
          aria-modal="false"
          className={`agent-chat-panel is-${mode}`}
          id="semester-assistant-chat"
          ref={panelRef}
          role="dialog"
          tabIndex="-1"
        >
          <header className="agent-chat-header">
            <span className="agent-chat-avatar"><Icon name="spark" size={19} /></span>
            <div>
              <strong>Semester Board</strong>
              <span><i aria-hidden="true" />{isCloud ? "Conversational AI · automated" : "Private lookup · on device"}</span>
            </div>
            <button aria-label="Close Semester Board chat" className="agent-chat-close" onClick={closeChat} type="button">
              <Icon name="close" size={18} />
            </button>
          </header>

          <div className="agent-chat-context-bar">
            <ModeSwitch mode={mode} onSelect={selectMode} />
            <AlertControl
              isOpen={isReminderSettingsOpen}
              onToggle={() => setIsReminderSettingsOpen((current) => !current)}
              push={push}
            />
          </div>

          {isReminderSettingsOpen ? <ReminderControls onClose={() => setIsReminderSettingsOpen(false)} push={push} syncMode={assistant.syncMode} /> : null}

          {nextReminder ? (
            <div className="agent-chat-next">
              <span><Icon name={nextReminder.type === "exam-7d" ? "flag" : "clock"} size={15} /></span>
              <p>
                <small>Next check-in</small>
                <strong>{nextReminder.title}</strong>
                <span>{formatMoment(nextReminder.remindAt)} · {nextReminder.courseCode}</span>
              </p>
            </div>
          ) : null}

          <ol
            aria-live="polite"
            aria-relevant="additions text"
            className="agent-chat-log"
            onScroll={trackLogPosition}
            ref={logRef}
            role="log"
          >
            {isCloud ? (
              <CloudConsentState
                actionRef={cloudActionRef}
                cloud={cloud}
                onUsePrivate={() => selectMode(LOCAL_MODE)}
              />
            ) : null}
            {visibleMessages.length ? visibleMessages.map((message) => (
              <ChatMessage key={message.id} message={message} />
            )) : (isCloud && cloud.status !== "ready" && cloud.status !== "streaming") ? null : (
              <li className="agent-chat-empty">
                <span><Icon name={isCloud ? "spark" : "message"} size={20} /></span>
                <p>
                  <strong>{isCloud ? "Talk through your semester" : "Private board lookup"}</strong>
                  <small>
                    {isCloud
                      ? "Ask a normal question, share what you’re working through, or continue with a follow-up—no commands needed."
                      : "Look up your next class, due work, exams, attendance, or reminders without sharing board data."}
                  </small>
                </p>
              </li>
            )}
            {isCloud && cloud.error && (cloud.status === "ready" || cloud.status === "streaming") ? (
              <li className="agent-chat-cloud-error" role="alert"><Icon name="warning" size={14} />{cloud.error}</li>
            ) : null}
          </ol>

          {(isCloud ? cloud.status === "ready" : true) ? (
            <div className="agent-chat-prompts" aria-label={isCloud ? "Conversation starters" : "Suggested private lookups"}>
              {(isCloud ? CHAT_STARTERS : PRIVATE_PROMPTS).map((prompt) => (
                <button key={prompt} onClick={() => ask(prompt)} type="button">{prompt}</button>
              ))}
            </div>
          ) : null}

          {!isCloud && assistant.notice ? (
            <div className="agent-chat-notice" role="status">
              <Icon name="info" size={14} />
              <span>{assistant.notice}</span>
              <button aria-label="Dismiss assistant notice" onClick={() => assistant.setNotice(null)} type="button"><Icon name="close" size={13} /></button>
            </div>
          ) : null}

          <form aria-busy={isCloud && cloud.status === "streaming"} className="agent-chat-composer" onSubmit={send}>
            <label className="visually-hidden" htmlFor="agent-chat-input">
              {isCloud ? "Message Semester Board" : "Ask a private board lookup"}
            </label>
            <textarea
              aria-describedby="agent-chat-mode-note"
              disabled={isComposerDisabled}
              id="agent-chat-input"
              maxLength="3000"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) send(event);
              }}
              placeholder={composerPlaceholder}
              ref={inputRef}
              rows="1"
              value={draft}
            />
            <button aria-label="Send message" disabled={!draft.trim() || isComposerDisabled} type="submit"><Icon name="send" size={17} /></button>
          </form>

          <footer className="agent-chat-footer">
            <p className="agent-chat-footnote" id="agent-chat-mode-note">
              {isCloud
                ? `${assistant.syncMode === "cloud" ? "Chat history syncs to your account" : "Chat is saved to this device-only profile"}; messages + the disclosed snapshot go to the configured AI provider`
                : "On-device board facts · no AI provider"}
            </p>
            <div aria-label="Chat and consent controls" className="agent-chat-history-controls" role="group">
              <button
                aria-controls="agent-chat-clear-confirmation"
                aria-expanded={confirmationAction === "clear"}
                onClick={() => requestHistoryAction("clear")}
                type="button"
              >
                {confirmationAction === "clear" ? "Cancel" : historyActionLabel}
              </button>
              {isCloud && (cloud.status === "ready" || cloud.status === "streaming") ? (
                <button
                  aria-controls="agent-chat-clear-confirmation"
                  aria-expanded={confirmationAction === "revoke"}
                  className="agent-chat-revoke"
                  onClick={() => requestHistoryAction("revoke")}
                  type="button"
                >
                  {confirmationAction === "revoke" ? "Cancel" : "Revoke Chat"}
                </button>
              ) : null}
              <span className="agent-chat-clear-confirmation" hidden={!confirmationAction} id="agent-chat-clear-confirmation">
                <span role="status">{confirmationLabel}</span>
                <button aria-label="Confirm assistant privacy action" onClick={confirmHistoryAction} type="button">Confirm</button>
              </span>
            </div>
          </footer>
        </section>
      ) : null}

      <button
        aria-controls="semester-assistant-chat"
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        aria-label={unreadCount ? `Open Semester Board chat, ${unreadCount} new messages` : "Open Semester Board chat"}
        className="agent-chat-launcher"
        onClick={openChat}
        ref={launcherRef}
        type="button"
      >
        <span className="agent-chat-launcher-icon"><Icon name="message" size={21} /></span>
        <span className="agent-chat-launcher-copy"><strong>Semester Board</strong><small>Chat about your semester</small></span>
        <i aria-hidden="true" className="agent-chat-online-dot" />
        {unreadCount ? <span aria-hidden="true" className="agent-chat-unread">{Math.min(unreadCount, 9)}</span> : null}
      </button>
    </div>
  );
}
