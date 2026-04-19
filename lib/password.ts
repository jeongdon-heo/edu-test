const ITERATIONS = 120_000;
const KEY_LEN_BITS = 256;
const SALT_BYTES = 16;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function derive(password: string, salt: Uint8Array): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations: ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    KEY_LEN_BITS
  );
  return bytesToBase64(new Uint8Array(bits));
}

export async function hashPassword(
  password: string
): Promise<{ hash: string; salt: string }> {
  const saltBytes = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, saltBytes);
  return { hash, salt: bytesToBase64(saltBytes) };
}

export async function verifyPassword(
  password: string,
  hash: string,
  salt: string
): Promise<boolean> {
  const saltBytes = base64ToBytes(salt);
  const candidate = await derive(password, saltBytes);
  if (candidate.length !== hash.length) return false;
  let diff = 0;
  for (let i = 0; i < candidate.length; i++) {
    diff |= candidate.charCodeAt(i) ^ hash.charCodeAt(i);
  }
  return diff === 0;
}
