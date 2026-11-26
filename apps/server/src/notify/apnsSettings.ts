import { createPrivateKey } from 'node:crypto';
import type { ApnsSettingsView } from '@marquee/shared';
import { getSetting, setSetting, type Db } from '../db/index.js';
import { HttpError } from '../http.js';

/** Everything Marquee needs to talk to Apple's push service. The key is a secret: it is kept, never sent back or logged. */
export interface ApnsConfig {
  key: string;
  keyId: string;
  teamId: string;
  bundleId: string;
}

const K = { key: 'apns.private_key', keyId: 'apns.key_id', teamId: 'apns.team_id', bundleId: 'apns.bundle_id' } as const;

export function readApns(db: Db): ApnsConfig | null {
  const key = getSetting(db, K.key);
  const keyId = getSetting(db, K.keyId);
  const teamId = getSetting(db, K.teamId);
  const bundleId = getSetting(db, K.bundleId);
  return key && keyId && teamId && bundleId ? { key, keyId, teamId, bundleId } : null;
}

export function apnsView(db: Db): ApnsSettingsView {
  return {
    keySet: Boolean(getSetting(db, K.key)),
    keyId: getSetting(db, K.keyId) ?? '',
    teamId: getSetting(db, K.teamId) ?? '',
    bundleId: getSetting(db, K.bundleId) ?? 'app.marquee.ios',
    ready: readApns(db) !== null,
  };
}

/** Checks the text is an Apple .p8 key (an EC private key) without ever repeating it. */
export function checkKey(text: string): void {
  try {
    const key = createPrivateKey(text);
    if (key.asymmetricKeyType !== 'ec') throw new Error('not ec');
  } catch {
    throw new HttpError(400, 'invalid_input', 'That doesn’t look like an Apple push key. Paste the whole text of the .p8 file, including the BEGIN and END lines.');
  }
}

export function writeApns(db: Db, input: { key?: string; keyId: string; teamId: string; bundleId: string }): void {
  const key = input.key?.trim();
  if (key) {
    checkKey(key);
    setSetting(db, K.key, key);
  }
  setSetting(db, K.keyId, input.keyId.trim());
  setSetting(db, K.teamId, input.teamId.trim());
  setSetting(db, K.bundleId, input.bundleId.trim());
}
