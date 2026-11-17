// Shared helpers: JSON replies, request bodies, and the deterministic logical
// clock. Nothing here reads the wall clock: every timestamp the forge emits
// comes from LogicalClock, so two runs of the same trial produce byte-identical
// state.

import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';

/** Deterministic clock. Starts at the competition opening and ticks 1s per call. */
export class LogicalClock {
  private tickCount = 0;
  private static readonly BASE_MS = Date.parse('2026-11-14T06:30:00.000Z');

  now(): string {
    const ms = LogicalClock.BASE_MS + this.tickCount * 1000;
    this.tickCount += 1;
    return new Date(ms).toISOString();
  }

  /** Unix seconds for git commit timestamps, from the same tick stream. */
  nowUnix(): number {
    const ms = LogicalClock.BASE_MS + this.tickCount * 1000;
    this.tickCount += 1;
    return Math.floor(ms / 1000);
  }
}

/** Send a JSON body with the standard headers. `extra` headers go beside them. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extra: Readonly<Record<string, string>> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    ...extra,
  });
  res.end(text);
}

/** Send a raw body (used for git smart HTTP) with explicit headers. */
export function sendRaw(
  res: ServerResponse,
  status: number,
  body: Buffer,
  extra: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, { 'content-length': body.length, ...extra });
  res.end(body);
}

/** Read a request body fully, up to `limit` bytes. Rejects on overflow or stream error. */
export function readBody(req: IncomingMessage, limit = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Parse a request body as JSON. Returns { ok: true, value } or
 * { ok: false } when the body is empty (caller decides) or malformed.
 */
export function parseJsonBody(
  buf: Buffer,
): { ok: true; value: unknown } | { ok: false; empty: boolean } {
  if (buf.length === 0) return { ok: false, empty: true };
  try {
    return { ok: true, value: JSON.parse(buf.toString('utf8')) };
  } catch {
    return { ok: false, empty: false };
  }
}

/** The path of a request URL, or '/' when it does not parse (never throws). */
export function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** Split a path into its non-empty segments. */
export function segments(path: string): string[] {
  return path.split('/').filter((s) => s.length > 0);
}
