import crypto from 'crypto';

/**
 * Cifrado AES-256-GCM para guardar tokens OAuth (Meta, Google) en reposo.
 *
 * Clave: process.env.RUTM_ENCRYPTION_KEY (64 hex chars = 32 bytes).
 * Generar con: openssl rand -hex 32
 *
 * Formato almacenado: "iv:authTag:ciphertext" en base64, separados por ":"
 */

function getKey(): Buffer {
  const hex = process.env.RUTM_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      'RUTM_ENCRYPTION_KEY must be 64 hex chars (32 bytes). Generate with: openssl rand -hex 32'
    );
  }
  return Buffer.from(hex, 'hex');
}

export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(12); // 96-bit IV recomendado para AES-GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('base64'), authTag.toString('base64'), encrypted.toString('base64')].join(
    ':'
  );
}

export function decrypt(ciphertext: string): string {
  const key = getKey();
  const parts = ciphertext.split(':');
  if (parts.length !== 3) throw new Error('Invalid ciphertext format');
  const [ivB64, authTagB64, encryptedB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const encrypted = Buffer.from(encryptedB64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted).toString('utf8') + decipher.final('utf8');
}
