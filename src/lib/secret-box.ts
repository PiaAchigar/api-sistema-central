import { AppError } from "./errors";

/**
 * Cifrado simétrico para los secretos de ARCA que viven en la base
 * (sdk_token / cert / key de cada facturador).
 *
 * AES-256-GCM con WebCrypto (disponible en Workers, sin dependencias). La master
 * key es el secreto `ARCA_SECRETS_KEY` del Worker: 32 bytes en base64. Así, un
 * dump de la base NO alcanza para emitir comprobantes a nombre de nadie — hace
 * falta además la master key, que nunca se guarda en Postgres.
 *
 * Formato en la columna: base64( iv(12 bytes) || ciphertext+tag ).
 *
 * Rotar la master key invalida TODOS los secretos guardados: hay que volver a
 * cargar los certificados de cada facturador desde el dashboard.
 */

const IV_BYTES = 12; // recomendado para GCM
const KEY_BYTES = 32; // AES-256

/** Genera una master key nueva lista para `wrangler secret put ARCA_SECRETS_KEY`. */
export function generateMasterKey(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(KEY_BYTES)));
}

async function importKey(rawBase64: string | undefined): Promise<CryptoKey> {
  if (!rawBase64) {
    throw new AppError(
      503,
      "Falta el secreto ARCA_SECRETS_KEY del Worker: sin él no se pueden guardar ni leer las credenciales de ARCA.",
    );
  }
  let raw: Uint8Array;
  try {
    raw = fromBase64(rawBase64.trim());
  } catch {
    throw new AppError(500, "ARCA_SECRETS_KEY no es base64 válido.");
  }
  if (raw.length !== KEY_BYTES) {
    throw new AppError(
      500,
      `ARCA_SECRETS_KEY debe ser de ${KEY_BYTES} bytes en base64 (tiene ${raw.length}).`,
    );
  }
  return crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptSecret(plaintext: string, masterKey: string | undefined) {
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

export async function decryptSecret(packedBase64: string, masterKey: string | undefined) {
  const key = await importKey(masterKey);
  let packed: Uint8Array;
  try {
    packed = fromBase64(packedBase64);
  } catch {
    throw new AppError(500, "Secreto de ARCA corrupto (no es base64).");
  }
  if (packed.length <= IV_BYTES) {
    throw new AppError(500, "Secreto de ARCA corrupto (demasiado corto).");
  }
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: packed.subarray(0, IV_BYTES) as BufferSource },
      key,
      packed.subarray(IV_BYTES) as BufferSource,
    );
    return new TextDecoder().decode(plain);
  } catch {
    // GCM falla la autenticación si la key no es la que cifró (o el dato se tocó)
    throw new AppError(
      500,
      "No se pudo descifrar la credencial de ARCA: ARCA_SECRETS_KEY no coincide con la que se usó para guardarla.",
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
