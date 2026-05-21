// Lightweight audit logging.
//
// Records security-relevant events — authn/authz outcomes, searches, edit
// proposals, PR creation — as single-line structured JSON on stdout, so a
// log aggregator (Cloudflare Logpush, Datadog, etc.) can ship and query them.
// There is no database (docs/v2-design.md §10): this is a log stream, not a
// queryable store. Pairing it with the GitHub commit/PR history gives a full
// "who changed what" trail.
//
// Privacy: this MUST NOT log search query text or document content. Only
// metadata (actor, event type, document ids, PR numbers, counts) is recorded
// so the audit trail itself does not become a second copy of confidential
// data — see the commercialization concerns around data residency.

export type AuditSource = "web" | "mcp" | "system";

export type AuditOutcome = "ok" | "denied" | "error";

export interface AuditEntry {
  // Dotted event name, e.g. "search", "pr.created", "auth.denied".
  event: string;
  // Email of the acting user, or a sentinel ("anonymous", "auth-disabled").
  actor: string;
  source: AuditSource;
  outcome?: AuditOutcome;
  // Event-specific metadata. MUST NOT contain query text or document bodies.
  detail?: Record<string, string | number | boolean | string[]>;
}

// Sentinels for when there is no authenticated email.
export const ACTOR_ANONYMOUS = "anonymous";
export const ACTOR_AUTH_DISABLED = "auth-disabled";

export function audit(entry: AuditEntry): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    ...entry,
  });
  // A distinct prefix so log drains can route/grep the audit stream.
  console.log(`[audit] ${line}`);
}
