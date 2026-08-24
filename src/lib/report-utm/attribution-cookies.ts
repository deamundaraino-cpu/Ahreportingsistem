import crypto from 'crypto';
import type { NextRequest, NextResponse } from 'next/server';

/**
 * Cookies de atribución (1st-party en nuestro dominio).
 *
 *   rutm_vid → visitor id persistente (90 días). Se setea una sola vez.
 *   rutm_sid → session id (30 min de inactividad).
 *   rutm_ft  → first-touch JSON: source, campaign, click_id, ts.
 *   rutm_lt  → last-touch JSON: idem (se sobreescribe en cada touch).
 */

const COOKIE_VID = 'rutm_vid';
const COOKIE_SID = 'rutm_sid';
const COOKIE_FT = 'rutm_ft';
const COOKIE_LT = 'rutm_lt';

const VID_MAX_AGE = 60 * 60 * 24 * 90; // 90 días
const SID_MAX_AGE = 60 * 30; // 30 min
const TOUCH_MAX_AGE = 60 * 60 * 24 * 90; // 90 días

export type Touch = {
  source: string | null;
  medium: string | null;
  campaign: string | null;
  content: string | null;
  term: string | null;
  click_id: string | null;
  ts: string;
  referrer: string | null;
};

export function readVisitor(req: NextRequest): { visitorId: string; sessionId: string } {
  const existingVid = req.cookies.get(COOKIE_VID)?.value;
  const existingSid = req.cookies.get(COOKIE_SID)?.value;
  return {
    visitorId:
      existingVid && /^[a-f0-9]{32}$/.test(existingVid)
        ? existingVid
        : crypto.randomBytes(16).toString('hex'),
    sessionId:
      existingSid && /^[a-f0-9]{16}$/.test(existingSid)
        ? existingSid
        : crypto.randomBytes(8).toString('hex'),
  };
}

export function readFirstTouch(req: NextRequest): Touch | null {
  const v = req.cookies.get(COOKIE_FT)?.value;
  if (!v) return null;
  try {
    return JSON.parse(decodeURIComponent(v)) as Touch;
  } catch {
    return null;
  }
}

export function setAttributionCookies(
  res: NextResponse,
  args: {
    visitorId: string;
    sessionId: string;
    newTouch: Touch | null;
    existingFirstTouch: Touch | null;
  }
) {
  const opts = {
    httpOnly: false, // el pixel JS lo lee en cliente
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
  };

  res.cookies.set(COOKIE_VID, args.visitorId, { ...opts, maxAge: VID_MAX_AGE });
  res.cookies.set(COOKIE_SID, args.sessionId, { ...opts, maxAge: SID_MAX_AGE });

  if (args.newTouch) {
    // Last-touch: siempre se sobreescribe
    res.cookies.set(COOKIE_LT, encodeURIComponent(JSON.stringify(args.newTouch)), {
      ...opts,
      maxAge: TOUCH_MAX_AGE,
    });
    // First-touch: solo si no existía
    if (!args.existingFirstTouch) {
      res.cookies.set(COOKIE_FT, encodeURIComponent(JSON.stringify(args.newTouch)), {
        ...opts,
        maxAge: TOUCH_MAX_AGE,
      });
    }
  }
}

export function buildTouchFromUrl(url: URL, referrer: string | null): Touch | null {
  const sp = url.searchParams;
  const fields: Touch = {
    source: sp.get('utm_source'),
    medium: sp.get('utm_medium'),
    campaign: sp.get('utm_campaign'),
    content: sp.get('utm_content'),
    term: sp.get('utm_term'),
    click_id: sp.get('fbclid') ?? sp.get('gclid') ?? sp.get('ttclid') ?? sp.get('click_id') ?? null,
    ts: new Date().toISOString(),
    referrer,
  };
  // Solo guardamos un touch si hay alguna señal de atribución
  const hasSignal = fields.source || fields.campaign || fields.click_id || fields.medium;
  return hasSignal ? fields : null;
}

export const COOKIE_NAMES = {
  visitor: COOKIE_VID,
  session: COOKIE_SID,
  firstTouch: COOKIE_FT,
  lastTouch: COOKIE_LT,
};
