// supabase/functions/voting-api/index.ts
//
// NOTE: Supabase Edge Functions run on Deno (TypeScript), not Node.js. The code below is
// ordinary modern TypeScript; only the import style (npm: prefix) differs from Node.
//
// Three routes:
//   GET  /voting-api/public-key    -> RSA public key so the browser can blind its token
//   POST /voting-api/issue-token   -> ID + face check, then BLIND-SIGNS the voter's blinded token
//   POST /voting-api/cast-vote     -> verifies the unblinded signature, then writes to the blockchain
//
// PRIVACY MODEL (why identity and ballot are separated):
//   1. The browser invents a random 32-byte token and "blinds" it (multiplies by a random factor).
//   2. /issue-token sees WHO the voter is, but only ever sees the blinded value, so it cannot
//      know the final token. It marks the ID as "token issued" (one token per citizen).
//   3. The browser removes the blinding factor and gets a valid authority signature on the token.
//   4. /cast-vote sees the token + signature + party choice, but has no idea who the voter is.
//
// PROTOTYPE LIMITS: network metadata (IP address, timing) could still link steps 2 and 4 if the
// same operator logs everything. See README for production hardening.

import { createClient } from "npm:@supabase/supabase-js@2";
import { ethers } from "npm:ethers@6";

// ----------------------------------------------------------------------------- HTTP helpers

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*", // Prototype only. In production, set your Vercel domain.
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = await req.json();
    if (parsed === null || typeof parsed !== "object") throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

function secret(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new HttpError(500, `Server is missing the secret ${name}.`);
  return value;
}

// ----------------------------------------------------------------------------- byte / bigint helpers

const encoder = new TextEncoder();

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) {
    throw new HttpError(400, "Malformed hex value.");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return BigInt("0x" + (hex === "" ? "0" : hex));
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Parses a hex string (no 0x needed) of at most ~4096 bits into a bigint. */
function parseBigHex(value: unknown, label: string): bigint {
  const text = String(value ?? "");
  if (!/^[0-9a-fA-F]{1,1100}$/.test(text)) {
    throw new HttpError(400, `${label} is not valid hex.`);
  }
  return BigInt("0x" + text);
}

/** Square-and-multiply modular exponentiation: base^exp mod modulus. */
function modPow(base: bigint, exp: bigint, modulus: bigint): bigint {
  let result = 1n;
  let b = base % modulus;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus;
    b = (b * b) % modulus;
    e >>= 1n;
  }
  return result;
}

// ----------------------------------------------------------------------------- RSA blind signatures

interface RsaKey {
  n: bigint;
  e: bigint;
  d: bigint;
}

let cachedKey: RsaKey | null = null;

function rsaKey(): RsaKey {
  if (!cachedKey) {
    cachedKey = {
      n: BigInt("0x" + secret("RSA_N")),
      e: BigInt("0x" + secret("RSA_E")),
      d: BigInt("0x" + secret("RSA_D")),
    };
  }
  return cachedKey;
}

/**
 * Full-domain hash: stretches SHA-256 over the whole RSA modulus size (9 x 256 = 2304 bits,
 * then reduced mod n). MUST be byte-for-byte identical to the browser implementation.
 */
async function fullDomainHash(tokenHex: string, n: bigint): Promise<bigint> {
  const tokenBytes = hexToBytes(tokenHex);
  const blocks: Uint8Array[] = [];
  for (let counter = 0; counter < 9; counter++) {
    const input = concatBytes(
      encoder.encode("SAVOTE-FDH-v1"),
      Uint8Array.of(counter),
      tokenBytes,
    );
    blocks.push(new Uint8Array(await crypto.subtle.digest("SHA-256", input)));
  }
  return bytesToBigInt(concatBytes(...blocks)) % n;
}

// ----------------------------------------------------------------------------- mock Home Affairs

interface IdCheck {
  valid: boolean;
  reason?: string;
}

/**
 * Validates the structure of a South African ID number (13 digits):
 *   YYMMDD  SSSS  C  A  Z
 *   birth   seq   citizen(0/1)  legacy(8/9)  Luhn check digit
 */
function validateSouthAfricanId(id: string): IdCheck {
  if (!/^\d{13}$/.test(id)) {
    return { valid: false, reason: "An ID number must be exactly 13 digits." };
  }

  const yy = Number(id.slice(0, 2));
  const month = Number(id.slice(2, 4));
  const day = Number(id.slice(4, 6));

  // Two-digit years are ambiguous. Assume 20xx unless that would be in the future.
  const now = new Date();
  let year = 2000 + yy;
  if (new Date(Date.UTC(year, month - 1, day)) > now) year = 1900 + yy;

  const birth = new Date(Date.UTC(year, month - 1, day));
  const dateIsReal =
    birth.getUTCFullYear() === year &&
    birth.getUTCMonth() === month - 1 &&
    birth.getUTCDate() === day;
  if (!dateIsReal) {
    return { valid: false, reason: "The date of birth inside this ID number is not a real date." };
  }

  if (id[10] !== "0" && id[10] !== "1") {
    return { valid: false, reason: "The citizenship digit of this ID number is invalid." };
  }

  // Luhn checksum: from the right, double every second digit.
  let sum = 0;
  for (let i = 0; i < 13; i++) {
    let digit = Number(id[i]);
    if ((12 - i) % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  if (sum % 10 !== 0) {
    return { valid: false, reason: "This ID number fails the checksum test. Check for a typing mistake." };
  }

  let age = now.getUTCFullYear() - year;
  const birthdayPassed =
    now.getUTCMonth() > month - 1 ||
    (now.getUTCMonth() === month - 1 && now.getUTCDate() >= day);
  if (!birthdayPassed) age -= 1;
  if (age < 18) {
    return { valid: false, reason: "Voters must be 18 or older." };
  }

  return { valid: true };
}

// ----------------------------------------------------------------------------- mock biometrics

interface FaceCheck {
  passed: boolean;
  reason: string;
  score: number;
}

/**
 * DUMMY facial check. A real system would call a certified liveness + face-matching service
 * and compare against the Home Affairs photo. Here we only confirm that a real image-sized
 * payload arrived, then derive a deterministic pseudo "match score" from the image hash.
 */
async function mockBiometricCheck(faceImageBase64: string): Promise<FaceCheck> {
  if (Deno.env.get("MOCK_BIOMETRIC_FAIL") === "true") {
    return { passed: false, score: 0.31, reason: "Face did not match the Home Affairs photo (simulated failure)." };
  }

  const payload = faceImageBase64.replace(/^data:image\/\w+;base64,/, "");
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
  } catch {
    return { passed: false, score: 0, reason: "The camera image could not be read. Please try again." };
  }

  if (bytes.length < 1500) {
    return { passed: false, score: 0, reason: "No face detected in the camera frame. Please try again." };
  }

  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const score = 0.9 + (digest[0] / 255) * 0.09; // always between 0.90 and 0.99
  return { passed: score >= 0.85, score, reason: "ok" };
}

// ----------------------------------------------------------------------------- Supabase + chain clients

function getSupabase() {
  return createClient(secret("SUPABASE_URL"), secret("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false },
  });
}

const CONTRACT_ABI = [
  "function partyCount() view returns (uint8)",
  "function electionOpen() view returns (bool)",
  "function tokenStatus(bytes32) view returns (uint8)",
  "function authorizeVoterToken(bytes32 blindSignature)",
  "function castVote(bytes32 blindSignature, uint8 partyId)",
];

function getChain() {
  const chainId = Number(Deno.env.get("CHAIN_ID") ?? "11155111");
  const provider = new ethers.JsonRpcProvider(secret("RPC_URL"), chainId, { staticNetwork: true });
  let privateKey = secret("RELAYER_PRIVATE_KEY");
  if (!privateKey.startsWith("0x")) privateKey = "0x" + privateKey;
  const wallet = new ethers.Wallet(privateKey, provider);
  const contract = new ethers.Contract(secret("CONTRACT_ADDRESS"), CONTRACT_ABI, wallet);
  return { provider, contract };
}

/**
 * Public RPCs sometimes under-estimate the priority fee ("tip"), which leaves transactions
 * stuck. We force a safe minimum, set by the MIN_PRIORITY_GWEI secret:
 *   Ethereum Sepolia: 2 (default)      Polygon Amoy: 30 (Polygon rejects tips below ~25 gwei)
 */
async function feeOverrides(provider: ethers.JsonRpcProvider) {
  const fee = await provider.getFeeData();
  const minTip = ethers.parseUnits(Deno.env.get("MIN_PRIORITY_GWEI") ?? "2", "gwei");
  const tip = fee.maxPriorityFeePerGas && fee.maxPriorityFeePerGas > minTip ? fee.maxPriorityFeePerGas : minTip;
  const base = fee.maxFeePerGas ?? tip * 2n;
  const maxFee = base > tip * 2n ? base : tip * 2n;
  return { maxPriorityFeePerGas: tip, maxFeePerGas: maxFee };
}

// ----------------------------------------------------------------------------- route: public key

function getPublicKey() {
  const { n, e } = rsaKey();
  return { n: n.toString(16), e: e.toString(16) };
}

// ----------------------------------------------------------------------------- route: issue token

async function issueToken(body: Record<string, unknown>) {
  const idNumber = String(body.idNumber ?? "").trim();
  const faceImage = String(body.faceImage ?? "");

  // 1. Is it a structurally valid South African ID of an adult?
  const idCheck = validateSouthAfricanId(idNumber);
  if (!idCheck.valid) throw new HttpError(422, idCheck.reason ?? "Invalid ID number.");

  // 2. Is the person in the (mock) Home Affairs registry?
  const supabase = getSupabase();
  const { data: person, error: lookupError } = await supabase
    .from("mock_registry")
    .select("id_number, full_name, token_issued")
    .eq("id_number", idNumber)
    .maybeSingle();
  if (lookupError) throw new HttpError(500, `Registry lookup failed: ${lookupError.message}`);
  if (!person) throw new HttpError(404, "This ID number was not found in the Home Affairs registry.");
  if (person.token_issued) {
    throw new HttpError(409, "A ballot token has already been issued for this ID number.");
  }

  // 3. Dummy biometric check (done BEFORE we burn the one-time issuance).
  const face = await mockBiometricCheck(faceImage);
  if (!face.passed) throw new HttpError(401, face.reason);

  // 4. Validate the blinded message sent by the browser.
  const { n, d } = rsaKey();
  const blinded = parseBigHex(body.blindedMessage, "blindedMessage");
  if (blinded <= 1n || blinded >= n) throw new HttpError(400, "blindedMessage is out of range.");

  // 5. Atomically claim the one-time issuance. If two requests race, only one row updates.
  const { data: claimed, error: claimError } = await supabase
    .from("mock_registry")
    .update({ token_issued: true, token_issued_at: new Date().toISOString() })
    .eq("id_number", idNumber)
    .eq("token_issued", false)
    .select("id_number");
  if (claimError) throw new HttpError(500, `Could not record token issuance: ${claimError.message}`);
  if (!claimed || claimed.length === 0) {
    throw new HttpError(409, "A ballot token has already been issued for this ID number.");
  }

  // 6. Blind-sign. We never learn the real token; we sign a scrambled number.
  try {
    const blindSignature = modPow(blinded, d, n);
    return {
      blindSignature: blindSignature.toString(16),
      voterName: person.full_name,
      biometricScore: Number(face.score.toFixed(3)),
    };
  } catch (err) {
    // Roll the claim back so a server fault does not lock the citizen out.
    await supabase
      .from("mock_registry")
      .update({ token_issued: false, token_issued_at: null })
      .eq("id_number", idNumber);
    throw err;
  }
}

// ----------------------------------------------------------------------------- route: cast vote

async function castVote(body: Record<string, unknown>) {
  const token = String(body.token ?? "");
  const partyId = Number(body.partyId);
  const voteSignature = String(body.voteSignature ?? "");

  if (!/^0x[0-9a-fA-F]{64}$/.test(token)) {
    throw new HttpError(400, "Ballot token must be 32 bytes of hex (0x followed by 64 characters).");
  }
  if (!Number.isInteger(partyId) || partyId < 0 || partyId > 255) {
    throw new HttpError(400, "partyId must be a whole number between 0 and 255.");
  }

  // 1. Did OUR authority sign this token? (RSA: signature^e mod n must equal the hash of the token)
  const { n, e } = rsaKey();
  const signature = parseBigHex(body.signature, "signature");
  const expected = await fullDomainHash(token, n);
  if (modPow(signature, e, n) !== expected) {
    throw new HttpError(403, "This ballot token was not signed by the election authority.");
  }

  // 2. Was the party choice made by whoever holds the token? (HMAC keyed with the token itself)
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    hexToBytes(token),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const choiceIsAuthentic = await crypto.subtle.verify(
    "HMAC",
    hmacKey,
    hexToBytes(voteSignature),
    encoder.encode(`SAVOTE|v1|${partyId}`),
  );
  if (!choiceIsAuthentic) throw new HttpError(403, "The vote signature does not match the ballot token.");

  // 3. Talk to the blockchain.
  const { provider, contract } = getChain();
  try {
    if (!(await contract.electionOpen())) throw new HttpError(409, "The election is closed.");

    const partyCount = Number(await contract.partyCount());
    if (partyId >= partyCount) throw new HttpError(422, "That party is not on the ballot.");

    const status = Number(await contract.tokenStatus(token));
    if (status === 2) throw new HttpError(409, "This ballot token has already been used to vote.");

    const overrides = await feeOverrides(provider);

    // Status 1 means a previous attempt authorized the token but failed before voting, so we
    // skip straight to casting. Status 0 means we still need to register the token.
    if (status === 0) {
      const authTx = await contract.authorizeVoterToken(token, overrides);
      await authTx.wait(1);
    }

    // NOTE: one relayer wallet sends transactions one after another. For many simultaneous
    // voters you would queue requests or rotate several relayer wallets to avoid nonce clashes.
    const voteTx = await contract.castVote(token, partyId, overrides);
    const receipt = await voteTx.wait(1);
    if (!receipt || receipt.status !== 1) {
      throw new HttpError(502, "The blockchain transaction did not succeed.");
    }

    return { txHash: receipt.hash, blockNumber: receipt.blockNumber, partyId };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    const message = (err as { shortMessage?: string; message?: string }).shortMessage ??
      (err as Error).message;
    console.error("Chain error:", message);
    throw new HttpError(502, `Blockchain rejected the request: ${message}`);
  }
}

// ----------------------------------------------------------------------------- router

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const path = new URL(req.url).pathname.replace(/\/+$/, "");

    if (req.method === "GET" && path.endsWith("/public-key")) {
      return reply(getPublicKey());
    }
    if (req.method === "POST" && path.endsWith("/issue-token")) {
      return reply(await issueToken(await readJson(req)));
    }
    if (req.method === "POST" && path.endsWith("/cast-vote")) {
      return reply(await castVote(await readJson(req)));
    }
    throw new HttpError(404, "Unknown route.");
  } catch (err) {
    if (err instanceof HttpError) return reply({ error: err.message }, err.status);
    console.error(err);
    return reply({ error: "Unexpected server error. Check the Edge Function logs." }, 500);
  }
});
