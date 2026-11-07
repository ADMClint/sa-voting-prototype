// Generates the election authority's RSA key pair (2048-bit) for blind signatures.
// Usage:  node scripts/generate-rsa-keys.mjs
// Copy the three printed lines into supabase/.env (they are SECRETS - never commit them).
import { generateKeyPairSync } from "node:crypto";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = privateKey.export({ format: "jwk" });

// JWK stores big numbers as base64url; we convert them to hex because the Edge Function reads hex.
const toHex = (base64url) => Buffer.from(base64url, "base64url").toString("hex");

console.log(`RSA_N=${toHex(jwk.n)}`);
console.log(`RSA_E=${toHex(jwk.e)}`);
console.log(`RSA_D=${toHex(jwk.d)}`);
