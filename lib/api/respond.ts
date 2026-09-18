import { NextResponse } from "next/server";

export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

export function bad(message: string, status = 400, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: message, ...extra }, { status });
}

/** A refusal from transition() is a 409 with the reason a person can read. */
export function refused(refusal: { code: string; message: string; invariant?: number; details?: unknown }) {
  return NextResponse.json({ error: refusal.message, refusal }, { status: 409 });
}

export function parseAsOf(value: string | null): Date | null {
  if (!value) return null;
  const numeric = Number(value);
  const date = Number.isFinite(numeric) && value.trim() !== "" ? new Date(numeric) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
