# SA Voting Prototype (Supabase + Ethereum Sepolia + React + Streamlit)

A functional end-to-end prototype of a tamper-evident voting flow. **Demo only. Not for real elections.**

```
 Browser (React, Vercel)                 Supabase Edge Function              Ethereum Sepolia
 ───────────────────────                 ──────────────────────              ────────────
 1 ID + face frame + BLINDED token ────► checks mock registry + face
                                         signs the blinded value (1 per ID)
 2 unblinds -> signed token  ◄─────────  (never sees the real token)
 3 token + signature + party ──────────► verifies signature (RSA)  ────────► authorizeVoterToken
   + HMAC "vote signature"               relayer wallet pays gas   ────────► castVote
 4 receipt hash  ◄─────────────────────  txHash, blockNumber
                                                                              ▲
                                  Streamlit dashboard (web3.py) reads logs ───┘
```

## Folder map

| File | Role |
|---|---|
| `contracts/SAVoting.sol` | Immutable ledger: tokens, double-vote protection, live tally |
| `supabase/schema.sql` | Mock Home Affairs registry (5 test citizens) |
| `supabase/functions/voting-api/index.ts` | ID + biometric mock, blind-signature issuance, vote relay |
| `supabase/.env.example` | Secrets the Edge Function needs |
| `scripts/generate-rsa-keys.mjs` | Creates the authority's RSA key pair |
| `frontend/src/App.jsx` | Voter UI (login, webcam, ballot, receipt) |
| `frontend/src/lib/blindSignature.js` | Browser-side blinding + hashing |
| `dashboard/app.py` | Live Streamlit dashboard |

## Setup order (about 30 minutes)

### 1. Wallets and the contract
1. Install MetaMask. Sepolia is built in: open the network list and switch on 'Show test networks' (chain id 11155111, currency ETH).
2. Create two accounts: a **deployer** and a **relayer**. Fund both from the Sepolia faucet (Google Cloud Web3 faucet or the pk910 proof-of-work faucet).
3. Open https://remix.ethereum.org, paste `contracts/SAVoting.sol`, compile with 0.8.24 and EVM version `paris`.
4. Deploy with the deployer account (Injected Provider - MetaMask). Constructor arguments:
   `"SA Municipal Election 2026 (Prototype)"`, `8`, and the **relayer address**.
5. Copy the contract address and the deployment block number from Etherscan.
6. Export the relayer's private key from MetaMask (Account details). Treat it as a test-only secret.

### 2. Supabase
1. Create a free project. In **SQL Editor** run `supabase/schema.sql`.
2. `node scripts/generate-rsa-keys.mjs` and copy the three lines into `supabase/.env` (start from `.env.example`).
3. Fill in `CONTRACT_ADDRESS` and `RELAYER_PRIVATE_KEY` in the same file.
4. With the Supabase CLI installed:
   ```
   supabase login
   supabase link --project-ref <your-project-ref>
   supabase secrets set --env-file supabase/.env
   supabase functions deploy voting-api --no-verify-jwt
   ```
   `--no-verify-jwt` is used because voters have no Supabase account. The function itself enforces every check.

### 3. React app
```
npm create vite@latest frontend-app -- --template react
cd frontend-app
npm install
npm install tailwindcss @tailwindcss/vite
```
Then copy this repo's `frontend/src/App.jsx`, `frontend/src/index.css`, `frontend/src/lib/blindSignature.js`,
`frontend/vite.config.js` and `frontend/.env.example` over the scaffold (delete `src/App.css`; keep the generated `src/main.jsx`).
Create `.env.local` from `.env.example` with your project ref, then `npm run dev`.
Deploy: push to GitHub, import in Vercel, add the same two variables, deploy.

### 4. Streamlit dashboard
```
cd dashboard
pip install -r requirements.txt
cp .streamlit/secrets.toml.example .streamlit/secrets.toml   # fill CONTRACT_ADDRESS and DEPLOY_BLOCK
streamlit run app.py
```
For Streamlit Community Cloud, push the `dashboard` folder to GitHub and paste the same keys into the app's Secrets box.

## Testing checklist
- Vote with `8001015009087`: you get a receipt and the dashboard updates within about 5 seconds.
- Use the same ID again: "token already issued".
- `1001015009084`: rejected as under 18. A typo'd ID: checksum error.
- Set `MOCK_BIOMETRIC_FAIL=true`, redeploy secrets: face failure message appears.
- Reset the demo: `update public.mock_registry set token_issued = false, token_issued_at = null;`

## What this prototype does NOT solve (read before showing it to anyone)
- **Network linkability:** if one operator logs IP addresses and timestamps for both `/issue-token` and `/cast-vote`, they could correlate them. Production needs separate operators, mixing delays, and no IP logging.
- **Relayer trust:** the relayer sees token + party at cast time and could refuse or delay votes (it cannot alter a vote once on-chain). It is also a single wallet, so it serialises transactions.
- **Public receipts vs coercion:** a verifiable receipt can also be used to prove how you voted to a coercer or vote buyer. Real systems weigh this trade-off carefully.
- **Lost token = no vote:** one token per ID, and it lives only in browser memory. A production system needs a safe re-issue protocol.
- **Mock identity and biometrics:** the registry is a table you control and the face check is a stub. Real Home Affairs/IEC integration, certified biometrics and legal approval are required.
- **Crypto:** RSA blind signatures here use a full-domain hash and are tested, but production should follow RFC 9474 with an audited library, hardware-protected keys, and an independent security review.
- **Endpoint abuse:** add rate limiting, CAPTCHA/WAF and a locked-down CORS origin before any public exposure.
