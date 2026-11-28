/**
 * Count keys are `<kind>.<outcome>`. The outcomes that must add up to
 * `<kind>.source` are `imported` (`matched` for people, `kept` for share grants), `already-imported`, `skipped.<reason>` and
 * `failed.<reason>`. Any other key (`link.live`, `whiteboard.images`) is
 * information only.
 */
const BALANCED =
  /^(imported|matched|kept|already-imported|skipped\.[a-z0-9-]+|failed\.[a-z0-9-]+)$/;

import type { Fingerprint } from './runner';

export type LossCode =
  | 'scene-invalid'
  | 'whiteboard-file-skipped'
  | 'document-convert-failed'
  | 'document-content-shorter';

export type Loss = {
  code: LossCode;
  projectId: string;
  detail: Record<string, unknown>;
};

export type InviteEntry = {
  email: string;
  status:
    | 'invited'
    | 'already-invited'
    | 'would-invite'
    | 'invited-email-failed'
    | 'cannot-accept'
    | 'invalid-email'
    /** a share recipient of a workspace still waiting for its owner */
    | 'would-invite-later'
    /** --no-new-invites: an invitation was sent and never accepted */
    | 'invited-not-accepted'
    /** --no-new-invites: never invited, and not invited now */
    | 'not-invited';
  /** docmost's refusal, or why the email failed */
  reason?: string;
  /** why: a workspace member, a project share, or both */
  for: string[];
};

export type ReportCheckpoint = {
  counts: Map<string, number>;
  warnings: number;
  links: { oldUrl: string; newUrl: string; pageUrl?: string }[];
  losses: number;
};

export class ImportReport {
  private readonly counts = new Map<string, number>();
  private readonly warnings: {
    code: string;
    detail: Record<string, unknown>;
  }[] = [];
  private readonly linkPairs: {
    oldUrl: string;
    newUrl: string;
    pageUrl?: string;
  }[] = [];
  private readonly lossList: Loss[] = [];
  private readonly failures: string[] = [];
  private readonly invites: InviteEntry[] = [];
  private readonly fingerprintsByProject = new Map<string, Fingerprint>();

  /** Everything recorded so far, to go back to if an item fails. */
  checkpoint(): ReportCheckpoint {
    return {
      counts: new Map(this.counts),
      warnings: this.warnings.length,
      links: this.linkPairs.map((l) => ({ ...l })),
      losses: this.lossList.length,
    };
  }

  rollback(to: ReportCheckpoint): void {
    this.counts.clear();
    for (const [k, v] of to.counts) this.counts.set(k, v);
    this.warnings.length = to.warnings;
    this.linkPairs.splice(0, this.linkPairs.length, ...to.links);
    this.lossList.length = to.losses;
  }

  count(key: string, by = 1): void {
    this.counts.set(key, (this.counts.get(key) ?? 0) + by);
  }

  get(key: string): number {
    return this.counts.get(key) ?? 0;
  }

  warn(code: string, detail: Record<string, unknown>): void {
    this.warnings.push({ code, detail });
  }

  warningsOf(code: string): Record<string, unknown>[] {
    return this.warnings.filter((w) => w.code === code).map((w) => w.detail);
  }

  /** Data that would not reach docmost. Verify fails on it unless accepted. */
  loss(
    code: LossCode,
    projectId: string,
    detail: Record<string, unknown>,
  ): void {
    this.lossList.push({ code, projectId, detail });
    this.warn(code, { projectId, ...detail });
  }

  losses(): Loss[] {
    return [...this.lossList];
  }

  /**
   * One pair per old URL. A second call for the same old URL (a project's
   * public link) makes that the redirect target and keeps the page URL beside it.
   */
  link(oldUrl: string, newUrl: string): void {
    const existing = this.linkPairs.find((l) => l.oldUrl === oldUrl);
    if (!existing) {
      this.linkPairs.push({ oldUrl, newUrl });
    } else if (existing.newUrl !== newUrl) {
      existing.pageUrl ??= existing.newUrl;
      existing.newUrl = newUrl;
    }
  }

  links(): { oldUrl: string; newUrl: string; pageUrl?: string }[] {
    return this.linkPairs.map((l) => ({ ...l }));
  }

  /** What a project held in mindspace, for verify and for the report file. */
  fingerprint(projectId: string, fp: Fingerprint): void {
    this.fingerprintsByProject.set(projectId, fp);
  }

  fingerprints(): Map<string, Fingerprint> {
    return new Map(this.fingerprintsByProject);
  }

  /** An invitation sent, found pending, or (dry run) that would be sent. */
  invite(entry: InviteEntry): void {
    this.invites.push(entry);
  }

  addInviteReasons(email: string, reasons: string[]): void {
    const entry = this.invites.find((i) => i.email === email);
    if (entry) entry.for = [...new Set([...entry.for, ...reasons])];
  }

  invited(): InviteEntry[] {
    return this.invites.map((i) => ({ ...i }));
  }

  /** A check that did not hold. Any entry makes the run exit 1. */
  fail(message: string): void {
    // mindspace names are free text: no newline or escape may reach the terminal
    message = message.replace(/[\u0000-\u001f\u007f-\u009f]/g, (c) =>
      c === '\n'
        ? '\\n'
        : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
    this.failures.push(message);
  }

  mismatches(): string[] {
    const out: string[] = [];
    const kinds = [...this.counts.keys()]
      .filter((k) => k.endsWith('.source'))
      .map((k) => k.slice(0, -'.source'.length));
    for (const kind of kinds) {
      const source = this.get(`${kind}.source`);
      let accounted = 0;
      for (const [key, n] of this.counts) {
        if (!key.startsWith(`${kind}.`)) continue;
        const outcome = key.slice(kind.length + 1);
        if (outcome === 'skipped' || outcome === 'failed') {
          out.push(`${kind}: ${n} ${outcome} without a named reason`);
        }
        if (outcome.startsWith('failed.') && n > 0) {
          out.push(
            `${kind}: ${n} failed (${outcome.slice('failed.'.length)}); see the item-failed warnings`,
          );
        }
        if (BALANCED.test(outcome)) accounted += n;
      }
      if (accounted !== source) {
        out.push(
          `${kind}: ${source} in mindspace, but ${accounted} imported, already imported, skipped or failed`,
        );
      }
    }
    return [...out, ...this.failures];
  }

  toJSON(): object {
    const warnings: Record<string, Record<string, unknown>[]> = {};
    for (const w of this.warnings) (warnings[w.code] ??= []).push(w.detail);
    return {
      counts: Object.fromEntries(
        [...this.counts].sort(([a], [b]) => a.localeCompare(b)),
      ),
      warnings,
      invited: this.invites,
      losses: this.lossList,
      fingerprints: Object.fromEntries(this.fingerprintsByProject),
      mismatches: this.mismatches(),
      links: this.linkPairs,
    };
  }

  toText(): string {
    const lines: string[] = ['Counts'];
    const keys = [...this.counts.keys()].sort();
    for (const key of keys) lines.push(`  ${key.padEnd(44)} ${this.get(key)}`);

    const byCode = new Map<string, Record<string, unknown>[]>();
    for (const w of this.warnings) {
      byCode.set(w.code, [...(byCode.get(w.code) ?? []), w.detail]);
    }
    lines.push('', `Warnings (${this.warnings.length})`);
    for (const [code, details] of [...byCode].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      lines.push(`  ${code} (${details.length})`);
      for (const d of details) lines.push(`    ${JSON.stringify(d)}`);
    }

    lines.push('', `Invited (${this.invites.length})`);
    for (const i of this.invites) {
      lines.push(`  ${i.status.padEnd(16)} ${i.email} (${i.for.join(', ')})`);
    }

    lines.push('', `Links (${this.linkPairs.length})`);
    for (const l of this.linkPairs) {
      lines.push(
        `  ${l.oldUrl} -> ${l.newUrl}${l.pageUrl ? ` (page ${l.pageUrl})` : ''}`,
      );
    }

    const mismatches = this.mismatches();
    lines.push('', `Mismatches (${mismatches.length})`);
    for (const m of mismatches) lines.push(`  ${m}`);
    return lines.join('\n');
  }
}
