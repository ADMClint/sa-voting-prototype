// src/App.jsx
// Mobile-first voter app: Step 1 login + face scan, Step 2 ballot, Step 3 receipt.
import { useEffect, useRef, useState } from "react";
import { createBlindedToken, hmacSha256Hex, sha256Hex } from "./lib/blindSignature.js";

const API_BASE = (import.meta.env.VITE_API_BASE || "").replace(/\/+$/, "");
const EXPLORER_URL = import.meta.env.VITE_EXPLORER_URL || "https://sepolia.etherscan.io";

// The id values MUST match the party order used by the smart contract and the dashboard.
// Colours are arbitrary demo colours, not official party branding.
const PARTIES = [
  { id: 0, short: "ANC", name: "African National Congress", color: "#15803d" },
  { id: 1, short: "DA", name: "Democratic Alliance", color: "#1d4ed8" },
  { id: 2, short: "MK", name: "uMkhonto weSizwe Party", color: "#111827" },
  { id: 3, short: "EFF", name: "Economic Freedom Fighters", color: "#dc2626" },
  { id: 4, short: "IFP", name: "Inkatha Freedom Party", color: "#b45309" },
  { id: 5, short: "FF Plus", name: "Freedom Front Plus", color: "#ea580c" },
  { id: 6, short: "ActionSA", name: "Action South Africa", color: "#0e7490" },
  { id: 7, short: "PA", name: "Patriotic Alliance", color: "#7e22ce" },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Quick checksum test so typos are caught instantly. The server repeats the full validation. */
function looksLikeSaId(id) {
  if (!/^\d{13}$/.test(id)) return false;
  let sum = 0;
  for (let i = 0; i < 13; i += 1) {
    let digit = Number(id[i]);
    if ((12 - i) % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/** Small wrapper around fetch that turns server errors into readable messages. */
async function callApi(route, body) {
  if (!API_BASE) {
    throw new Error("VITE_API_BASE is not set. Add it to frontend/.env.local and restart npm run dev.");
  }
  let response;
  try {
    response = await fetch(`${API_BASE}/${route}`, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error("Cannot reach the voting server. Check your internet connection and the VITE_API_BASE value.");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `The server returned an error (${response.status}).`);
  return data;
}

// ------------------------------------------------------------------ small UI pieces

function StepIndicator({ step }) {
  const steps = [
    { key: "login", label: "Verify" },
    { key: "ballot", label: "Vote" },
    { key: "receipt", label: "Receipt" },
  ];
  const activeIndex = steps.findIndex((s) => s.key === step);
  return (
    <ol className="flex items-center justify-center gap-2 text-xs font-medium sm:text-sm">
      {steps.map((s, index) => (
        <li key={s.key} className="flex items-center gap-2">
          <span
            className={
              "flex h-7 w-7 items-center justify-center rounded-full " +
              (index <= activeIndex ? "bg-emerald-600 text-white" : "bg-slate-200 text-slate-500")
            }
          >
            {index + 1}
          </span>
          <span className={index <= activeIndex ? "text-slate-900" : "text-slate-400"}>{s.label}</span>
          {index < steps.length - 1 && <span className="mx-1 h-px w-6 bg-slate-300 sm:w-10" />}
        </li>
      ))}
    </ol>
  );
}

function ErrorBanner({ message, onDismiss }) {
  if (!message) return null;
  return (
    <div role="alert" className="flex items-start gap-3 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800">
      <span className="font-bold">Error</span>
      <p className="flex-1">{message}</p>
      {onDismiss && (
        <button type="button" onClick={onDismiss} className="font-semibold underline">
          Dismiss
        </button>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ main component

export default function App() {
  const [step, setStep] = useState("login"); // "login" | "ballot" | "receipt"
  const [error, setError] = useState("");

  // Step 1 state
  const [idNumber, setIdNumber] = useState("");
  const [phase, setPhase] = useState("idle"); // "idle" | "camera" | "scanning" | "verifying"
  const [progress, setProgress] = useState(0);
  const [usingFakeCamera, setUsingFakeCamera] = useState(false);

  // Step 2 state
  const [voterName, setVoterName] = useState("");
  const [selected, setSelected] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Step 3 state
  const [receipt, setReceipt] = useState(null);
  const [copied, setCopied] = useState(false);

  const videoRef = useRef(null);
  const streamRef = useRef(null);
  // The secret ballot token lives ONLY in memory. It is never written to storage.
  const credentialRef = useRef(null);

  // Warn before a refresh would destroy the one-time token (the ID can only be issued once).
  useEffect(() => {
    if (step !== "ballot") return undefined;
    const warn = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [step]);

  // Always switch the camera off when leaving the page.
  useEffect(() => () => stopCamera(), []);

  function stopCamera() {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  }

  // ---------------------------------------------------------------- Step 1 actions

  async function startCamera() {
    setError("");
    if (!looksLikeSaId(idNumber)) {
      setError("Please enter a valid 13-digit South African ID number.");
      return;
    }
    setPhase("camera");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: 320, height: 240 },
        audio: false,
      });
      streamRef.current = stream;
      setUsingFakeCamera(false);
      if (videoRef.current) videoRef.current.srcObject = stream;
    } catch {
      // Camera blocked or missing: continue in demo mode with a simulated frame.
      setUsingFakeCamera(true);
    }
  }

  /** Grabs one JPEG frame from the webcam, or draws random noise when no camera is available. */
  function captureFrame() {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 240;
    const context = canvas.getContext("2d");
    const video = videoRef.current;

    if (streamRef.current && video && video.videoWidth > 0) {
      context.drawImage(video, 0, 0, 320, 240);
    } else {
      const image = context.createImageData(320, 240);
      for (let i = 0; i < image.data.length; i += 4) {
        image.data[i] = Math.floor(Math.random() * 256);
        image.data[i + 1] = Math.floor(Math.random() * 256);
        image.data[i + 2] = Math.floor(Math.random() * 256);
        image.data[i + 3] = 255;
      }
      context.putImageData(image, 0, 0);
    }
    return canvas.toDataURL("image/jpeg", 0.7).split(",")[1];
  }

  async function scanAndVerify() {
    setError("");
    setPhase("scanning");
    setProgress(0);

    const faceImage = captureFrame();
    for (let p = 10; p <= 100; p += 10) {
      setProgress(p);
      await sleep(180);
    }
    stopCamera();
    setPhase("verifying");

    try {
      // 1. Get the authority's public key, then create our secret token and blind it.
      const publicKey = await callApi("public-key");
      const blinded = await createBlindedToken(publicKey.n, publicKey.e);

      // 2. Server checks ID + face and signs the BLINDED value (it never sees the token).
      const result = await callApi("issue-token", {
        idNumber,
        faceImage,
        blindedMessage: blinded.blindedHex,
      });

      // 3. Remove the blinding. Now we own a valid signed token that is unlinkable to our ID.
      const signature = blinded.finish(result.blindSignature);
      credentialRef.current = { token: blinded.token, signature };

      setVoterName(result.voterName);
      setIdNumber(""); // the ID number is not needed again, so we drop it from memory
      setPhase("idle");
      setStep("ballot");
    } catch (err) {
      setError(err.message);
      setPhase("idle");
    }
  }

  // ---------------------------------------------------------------- Step 2 / 3 actions

  async function submitVote() {
    if (!selected || !credentialRef.current) return;
    setSubmitting(true);
    setError("");

    const { token, signature } = credentialRef.current;
    try {
      // "Sign the vote with the token": an HMAC keyed by the secret token proves this exact
      // party choice came from the token holder.
      const voteSignature = await hmacSha256Hex(token, `SAVOTE|v1|${selected.id}`);

      const result = await callApi("cast-vote", {
        token,
        signature,
        partyId: selected.id,
        voteSignature,
      });

      // The receipt hash binds token + party + blockchain transaction together.
      const receiptHash = await sha256Hex(`${token}|${selected.id}|${result.txHash}`);

      setReceipt({
        receiptHash,
        txHash: result.txHash,
        blockNumber: result.blockNumber,
        party: selected,
        privateToken: token,
        castAt: new Date().toLocaleString("en-ZA"),
      });
      credentialRef.current = null; // the token is spent, so we discard it
      setConfirming(false);
      setStep("receipt");
    } catch (err) {
      setError(err.message);
      setConfirming(false);
    } finally {
      setSubmitting(false);
    }
  }

  async function copyReceipt() {
    try {
      await navigator.clipboard.writeText(receipt.receiptHash);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Could not copy automatically. Please select the hash and copy it manually.");
    }
  }

  function startOver() {
    setStep("login");
    setSelected(null);
    setConfirming(false);
    setReceipt(null);
    setVoterName("");
    setError("");
    setPhase("idle");
  }

  const cameraVisible = phase === "camera" || phase === "scanning";
  const busy = phase === "scanning" || phase === "verifying";

  // ---------------------------------------------------------------- render

  return (
    <div className="min-h-screen">
      <header className="bg-gradient-to-r from-emerald-700 via-emerald-600 to-yellow-500 px-4 py-5 text-white shadow">
        <h1 className="text-center text-lg font-bold sm:text-2xl">SA Digital Ballot</h1>
        <p className="text-center text-xs opacity-90 sm:text-sm">Prototype on Ethereum Sepolia testnet. Not a real election.</p>
      </header>

      <main className="mx-auto w-full max-w-xl space-y-5 p-4 sm:p-6">
        <StepIndicator step={step} />
        <ErrorBanner message={error} onDismiss={() => setError("")} />

        {/* ------------------------------------------------ STEP 1: LOGIN */}
        {step === "login" && (
          <section className="space-y-4 rounded-2xl bg-white p-5 shadow">
            <h2 className="text-lg font-semibold text-slate-900">Verify your identity</h2>

            <label className="block text-sm font-medium text-slate-700" htmlFor="idNumber">
              South African ID number
            </label>
            <input
              id="idNumber"
              inputMode="numeric"
              maxLength={13}
              value={idNumber}
              disabled={phase !== "idle"}
              onChange={(event) => setIdNumber(event.target.value.replace(/\D/g, ""))}
              placeholder="13 digits"
              className="w-full rounded-lg border border-slate-300 px-3 py-3 text-lg tracking-widest focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-200 disabled:bg-slate-100"
            />
            <p className="text-xs text-slate-500">
              Demo IDs: 8001015009087, 9202204720083, 8512125800082, 0003155123080 (and 1001015009084, which is under 18 and must be rejected).
            </p>

            {/* The video element is always mounted so the camera stream can attach to it. */}
            <div className={cameraVisible ? "block" : "hidden"}>
              <div className="relative mx-auto aspect-[4/3] w-full max-w-sm overflow-hidden rounded-xl bg-slate-900">
                <video ref={videoRef} autoPlay playsInline muted className="h-full w-full -scale-x-100 object-cover" />
                {usingFakeCamera && (
                  <div className="absolute inset-0 flex items-center justify-center bg-slate-800 p-4 text-center text-sm text-slate-200">
                    Camera unavailable. Using a simulated face scan for this demo.
                  </div>
                )}
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <div
                    className={
                      "h-44 w-32 rounded-[50%] border-4 sm:h-52 sm:w-40 " +
                      (phase === "scanning" ? "animate-pulse border-emerald-400" : "border-white/70")
                    }
                  />
                </div>
              </div>
              {phase === "scanning" && (
                <div className="mx-auto mt-3 h-2 w-full max-w-sm overflow-hidden rounded-full bg-slate-200">
                  <div className="h-full bg-emerald-500 transition-all duration-150" style={{ width: `${progress}%` }} />
                </div>
              )}
            </div>

            {phase === "idle" && (
              <button
                type="button"
                onClick={startCamera}
                disabled={idNumber.length !== 13}
                className="w-full rounded-lg bg-emerald-600 py-3 font-semibold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                Continue to face scan
              </button>
            )}
            {phase === "camera" && (
              <button
                type="button"
                onClick={scanAndVerify}
                className="w-full rounded-lg bg-emerald-600 py-3 font-semibold text-white transition hover:bg-emerald-700"
              >
                Scan my face
              </button>
            )}
            {phase === "scanning" && <p className="text-center text-sm text-slate-600">Scanning, please hold still ({progress}%)</p>}
            {phase === "verifying" && (
              <p className="text-center text-sm text-slate-600">Checking the registry and creating your anonymous ballot token</p>
            )}
          </section>
        )}

        {/* ------------------------------------------------ STEP 2: BALLOT */}
        {step === "ballot" && (
          <section className="space-y-4 rounded-2xl bg-white p-5 shadow">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">Welcome, {voterName}</h2>
              <p className="text-sm text-slate-600">
                Your identity is verified and has been separated from your ballot. Choose one party. Do not refresh this page.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {PARTIES.map((party) => {
                const isSelected = selected?.id === party.id;
                return (
                  <button
                    key={party.id}
                    type="button"
                    disabled={submitting}
                    onClick={() => {
                      setSelected(party);
                      setConfirming(false);
                    }}
                    aria-pressed={isSelected}
                    className={
                      "rounded-xl border-2 p-3 text-left transition focus:outline-none focus:ring-2 focus:ring-emerald-300 " +
                      (isSelected ? "border-emerald-600 bg-emerald-50" : "border-slate-200 bg-white hover:border-slate-400")
                    }
                  >
                    <span
                      className="mb-2 flex h-10 w-10 items-center justify-center rounded-full text-xs font-bold text-white"
                      style={{ backgroundColor: party.color }}
                    >
                      {party.short.slice(0, 3)}
                    </span>
                    <span className="block text-sm font-semibold text-slate-900">{party.short}</span>
                    <span className="block text-xs text-slate-500">{party.name}</span>
                  </button>
                );
              })}
            </div>

            {selected && !confirming && (
              <button
                type="button"
                onClick={() => setConfirming(true)}
                className="w-full rounded-lg bg-emerald-600 py-3 font-semibold text-white transition hover:bg-emerald-700"
              >
                Review my vote for {selected.short}
              </button>
            )}

            {selected && confirming && (
              <div className="space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-4">
                <p className="text-sm text-amber-900">
                  You are voting for <strong>{selected.name}</strong>. A vote written to the blockchain can never be changed.
                </p>
                <div className="flex gap-3">
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={() => setConfirming(false)}
                    className="flex-1 rounded-lg border border-slate-300 bg-white py-3 font-semibold text-slate-700 disabled:opacity-50"
                  >
                    Go back
                  </button>
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={submitVote}
                    className="flex-1 rounded-lg bg-emerald-600 py-3 font-semibold text-white hover:bg-emerald-700 disabled:cursor-wait disabled:bg-emerald-300"
                  >
                    {submitting ? "Sending to blockchain" : "Confirm and cast vote"}
                  </button>
                </div>
                {submitting && <p className="text-xs text-amber-800">This can take 5 to 15 seconds while two blockchain transactions confirm.</p>}
              </div>
            )}
          </section>
        )}

        {/* ------------------------------------------------ STEP 3: RECEIPT */}
        {step === "receipt" && receipt && (
          <section className="space-y-4 rounded-2xl bg-white p-5 shadow">
            <div className="text-center">
              <div className="mx-auto mb-2 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-2xl text-emerald-700">
                ✓
              </div>
              <h2 className="text-lg font-semibold text-slate-900">Your vote has been recorded</h2>
              <p className="text-sm text-slate-600">Cast for {receipt.party.name} on {receipt.castAt}</p>
            </div>

            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Cryptographic tracking receipt hash</p>
              <p className="mt-1 break-all rounded-lg bg-slate-900 p-3 font-mono text-xs text-emerald-300">{receipt.receiptHash}</p>
              <button type="button" onClick={copyReceipt} className="mt-2 text-sm font-semibold text-emerald-700 underline">
                {copied ? "Copied" : "Copy receipt hash"}
              </button>
            </div>

            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Blockchain transaction (block {receipt.blockNumber})</p>
              <a
                href={`${EXPLORER_URL}/tx/${receipt.txHash}`}
                target="_blank"
                rel="noreferrer"
                className="mt-1 block break-all text-sm text-blue-700 underline"
              >
                {receipt.txHash}
              </a>
            </div>

            <details className="rounded-lg border border-slate-200 p-3 text-sm text-slate-700">
              <summary className="cursor-pointer font-semibold">How to verify your vote</summary>
              <ol className="mt-2 list-decimal space-y-1 pl-5">
                <li>Open the transaction link above and look at the VoteCast log.</li>
                <li>Check that the party number matches your choice ({receipt.party.short} is number {receipt.party.id}).</li>
                <li>Recompute SHA-256 of: token, party number and transaction hash joined with the | character. It must equal your receipt hash.</li>
              </ol>
              <p className="mt-2 text-xs text-red-700">Your private token is shown below. Anyone who sees it can prove how you voted, so do not share it.</p>
              <p className="mt-1 break-all rounded bg-slate-100 p-2 font-mono text-xs">{receipt.privateToken}</p>
            </details>

            <button
              type="button"
              onClick={startOver}
              className="w-full rounded-lg border border-slate-300 py-3 font-semibold text-slate-700 hover:bg-slate-50"
            >
              Finish and clear this screen
            </button>
          </section>
        )}
      </main>
    </div>
  );
}
