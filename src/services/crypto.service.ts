import { AppError } from "../lib/errors";

/**
 * Cifrado simétrico para las credenciales de canal (Fase 6: tokens de WhatsApp
 * Cloud API, etc.) que viven en `channel_credentials.encrypted_credentials`.
 *
 * AES-256-GCM vía WebCrypto (nativa en Workers, sin dependencias). La master key
 * es el secreto `CREDENTIALS_ENCRYPTION_KEY` del Worker: 32 bytes en base64. Un
 * dump de la base no alcanza para usar las credenciales — hace falta además la
 * master key, que nunca se guarda en Postgres.
 *
 * Formato en la columna: base64( iv(12 bytes) || ciphertext+tag ).
 *
 * Rotar la master key invalida TODAS las credenciales guardadas: hay que volver
 * a cargarlas desde Canales. Mismo patrón que `lib/secret-box.ts` (ARCA), pero
 * código y master key separados a propósito.
 */

const IV_BYTES = 12;
const KEY_BYTES = 32;

async function importKey(rawBase64: string | undefined): Promise<CryptoKey> {
  if (!rawBase64) {
    throw new AppError(
      503,
      "Falta el secreto CREDENTIALS_ENCRYPTION_KEY del Worker: sin él no se pueden guardar ni leer credenciales de canal.",
    );
  }
  let raw: Uint8Array;
  try {
    raw = fromBase64(rawBase64.trim());
  } catch {
    throw new AppError(500, "CREDENTIALS_ENCRYPTION_KEY no es base64 válido.");
  }
  if (raw.length !== KEY_BYTES) {
    throw new AppError(
      500,
      `CREDENTIALS_ENCRYPTION_KEY debe ser de ${KEY_BYTES} bytes en base64 (tiene ${raw.length}).`,
    );
  }
  return crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encrypt(plaintext: string, masterKey: string | undefined): Promise<string> {
  const key = await importKey(masterKey);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      new TextEncoder().encode(plaintext) as BufferSource,
    ),
  );
  const packed = new Uint8Array(iv.length + ciphertext.length);
  packed.set(iv, 0);
  packed.set(ciphertext, iv.length);
  return toBase64(packed);
}

export async function decrypt(
  packedBase64: string,
  masterKey: string | undefined,
): Promise<string> {
  const key = await importKey(masterKey);
  let packed: Uint8Array;
  try {
    packed = fromBase64(packedBase64);
  } catch {
    throw new AppError(500, "Credencial de canal corrupta (no es base64).");
  }
  if (packed.length <= IV_BYTES) {
    throw new AppError(500, "Credencial de canal corrupta (demasiado corta).");
  }
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: packed.subarray(0, IV_BYTES) as BufferSource },
      key,
      packed.subarray(IV_BYTES) as BufferSource,
    );
    return new TextDecoder().decode(plain);
  } catch {
    throw new AppError(
      500,
      "No se pudo descifrar la credencial de canal: CREDENTIALS_ENCRYPTION_KEY no coincide con la que se usó para guardarla.",
    );
  }
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
