import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from "node:crypto";

/**
 * Envelope encryption for secrets stored in the database (D-10 style): each value gets its own
 * random data key (AES-256-GCM); the data key is wrapped with the key-encryption key (KEK) from
 * the environment. Rotating the KEK only needs the wrapped keys re-wrapped, and the previous KEK
 * stays readable while that happens.
 *
 * Stored format (all base64url): v1.<kekId>.<wrapIv>.<wrappedKey+tag>.<iv>.<ciphertext+tag>
 */
export type SecretBox = {
  encrypt(plaintext: Buffer | string): string;
  decrypt(sealed: string): Buffer;
  /** True when the value was sealed with an older key and should be re-encrypted. */
  needsRewrap(sealed: string): boolean;
};

type Kek = { id: string; key: Buffer };

const IV_BYTES = 12;
const TAG_BYTES = 16;

function deriveKek(material: string): Kek {
  // The configured value may be any long random string; HKDF turns it into a 256-bit key.
  const key = Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(material, "utf8"),
      Buffer.alloc(0),
      "gym-saas:kek:v1",
      32,
    ),
  );
  const id = createHash("sha256").update(key).digest("hex").slice(0, 8);
  return { id, key };
}

function seal(key: Buffer, plaintext: Buffer): { iv: Buffer; body: Buffer } {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([
    cipher.update(plaintext),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return { iv, body };
}

function open(key: Buffer, iv: Buffer, body: Buffer): Buffer {
  if (body.length < TAG_BYTES) throw new Error("sealed value is too short");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
  return Buffer.concat([
    decipher.update(body.subarray(0, body.length - TAG_BYTES)),
    decipher.final(),
  ]);
}

const b64 = (b: Buffer) => b.toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url");

export function createSecretBox(options: {
  key: string;
  previousKey?: string | null;
}): SecretBox {
  const current = deriveKek(options.key);
  const keks = new Map<string, Kek>([[current.id, current]]);
  if (options.previousKey) {
    const previous = deriveKek(options.previousKey);
    keks.set(previous.id, previous);
  }

  function parse(sealed: string) {
    const parts = sealed.split(".");
    if (parts.length !== 6 || parts[0] !== "v1")
      throw new Error("not a sealed secret");
    const [, kekId, wrapIv, wrapped, iv, body] = parts as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    return { kekId, wrapIv, wrapped, iv, body };
  }

  return {
    encrypt(plaintext) {
      const dataKey = randomBytes(32);
      const wrapped = seal(current.key, dataKey);
      const body = seal(
        dataKey,
        typeof plaintext === "string" ? Buffer.from(plaintext) : plaintext,
      );
      dataKey.fill(0);
      return [
        "v1",
        current.id,
        b64(wrapped.iv),
        b64(wrapped.body),
        b64(body.iv),
        b64(body.body),
      ].join(".");
    },
    decrypt(sealed) {
      const parts = parse(sealed);
      const kek = keks.get(parts.kekId);
      if (!kek)
        throw new Error(
          "sealed with an unknown key; set DATA_ENCRYPTION_KEY_PREVIOUS",
        );
      const dataKey = open(kek.key, unb64(parts.wrapIv), unb64(parts.wrapped));
      try {
        return open(dataKey, unb64(parts.iv), unb64(parts.body));
      } finally {
        dataKey.fill(0);
      }
    },
    needsRewrap(sealed) {
      return parse(sealed).kekId !== current.id;
    },
  };
}
