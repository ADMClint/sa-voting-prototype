# dashboard/app.py
# Live public results dashboard. It reads the SAVoting contract directly from the blockchain
# (never from our database or API). Look and feel lives in ui.py.
import os
import threading
from datetime import datetime, timezone

import pandas as pd
import streamlit as st
from web3 import Web3
from web3.middleware import ExtraDataToPOAMiddleware

import ui

st.set_page_config(
    page_title="SA Live Election Results",
    page_icon="🗳️",
    layout="wide",
    initial_sidebar_state="collapsed",
)

LOG_CHUNK_SIZE = 2000   # public RPC nodes limit how many blocks one log query may span
REFRESH_SECONDS = 5

CONTRACT_ABI = [
    {"type": "function", "name": "getLiveTally", "stateMutability": "view", "inputs": [],
     "outputs": [{"name": "partyTally", "type": "uint256[]"}, {"name": "total", "type": "uint256"}]},
    {"type": "function", "name": "getAuthorizedCount", "stateMutability": "view", "inputs": [],
     "outputs": [{"name": "", "type": "uint256"}]},
    {"type": "function", "name": "electionOpen", "stateMutability": "view", "inputs": [],
     "outputs": [{"name": "", "type": "bool"}]},
    {"type": "function", "name": "electionName", "stateMutability": "view", "inputs": [],
     "outputs": [{"name": "", "type": "string"}]},
    {"type": "function", "name": "partyCount", "stateMutability": "view", "inputs": [],
     "outputs": [{"name": "", "type": "uint8"}]},
]

# keccak256 of the event signature. Every VoteCast log on the chain starts with this topic.
VOTE_CAST_SIGNATURE = "VoteCast(bytes32,uint8,uint64)"


def get_setting(name, default=None):
    """Reads a setting from Streamlit secrets first, then from environment variables."""
    try:
        if name in st.secrets:
            return str(st.secrets[name])
    except Exception:
        pass
    return os.getenv(name, default)


class VoteLedger:
    """Reads and caches VoteCast events. One shared instance serves every browser session."""

    def __init__(self, rpc_url, contract_address, start_block):
        self.w3 = Web3(Web3.HTTPProvider(rpc_url, request_kwargs={"timeout": 20}))
        # Some chains (Polygon, BNB) add extra header bytes; this middleware is harmless on Sepolia.
        self.w3.middleware_onion.inject(ExtraDataToPOAMiddleware, layer=0)
        self.address = Web3.to_checksum_address(contract_address)
        self.contract = self.w3.eth.contract(address=self.address, abi=CONTRACT_ABI)
        self.topic = Web3.to_hex(Web3.keccak(text=VOTE_CAST_SIGNATURE))
        self.next_block = start_block
        self.events = []
        self.lock = threading.Lock()

    def sync(self):
        """Scans any blocks we have not read yet and appends new VoteCast events."""
        with self.lock:
            latest = self.w3.eth.block_number
            while self.next_block <= latest:
                end = min(self.next_block + LOG_CHUNK_SIZE - 1, latest)
                logs = self.w3.eth.get_logs({
                    "address": self.address,
                    "fromBlock": self.next_block,
                    "toBlock": end,
                    "topics": [self.topic],
                })
                for log in logs:
                    # topics[1] = token (bytes32), topics[2] = partyId (uint8, left-padded to 32 bytes)
                    # data      = timestamp (uint64, left-padded to 32 bytes)
                    self.events.append({
                        "block": log["blockNumber"],
                        "token": Web3.to_hex(bytes(log["topics"][1])),
                        "party_id": int.from_bytes(bytes(log["topics"][2]), "big"),
                        "timestamp": int.from_bytes(bytes(log["data"]), "big"),
                        "tx_hash": Web3.to_hex(log["transactionHash"]),
                    })
                self.next_block = end + 1
            return latest

    def average_block_time(self, latest, sample=50):
        """Average seconds between blocks over the most recent `sample` blocks."""
        older_number = max(latest - sample, 0)
        span = latest - older_number
        if span == 0:
            return 0.0
        newest = self.w3.eth.get_block(latest)
        older = self.w3.eth.get_block(older_number)
        return (newest["timestamp"] - older["timestamp"]) / span


@st.cache_resource(show_spinner="Connecting to Ethereum Sepolia")
def get_ledger(rpc_url, contract_address, start_block):
    return VoteLedger(rpc_url, contract_address, start_block)


def local_time_text():
    """Current time in South Africa (falls back to UTC if the timezone database is missing)."""
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo("Africa/Johannesburg")).strftime("%H:%M:%S SAST")
    except Exception:
        return datetime.now(timezone.utc).strftime("%H:%M:%S UTC")


def show(markup):
    st.markdown(markup, unsafe_allow_html=True)


# ---------------------------------------------------------------- configuration

rpc_url = get_setting("RPC_URL", "https://ethereum-sepolia-rpc.publicnode.com")
contract_address = get_setting("CONTRACT_ADDRESS")
start_block = int(get_setting("DEPLOY_BLOCK", "0"))
explorer_url = get_setting("EXPLORER_URL", "https://sepolia.etherscan.io").rstrip("/")
# Set SHOW_LEDGER = "false" in the secrets to hide transaction and token details from viewers.
show_ledger = get_setting("SHOW_LEDGER", "true").strip().lower() != "false"

show(ui.css())

if not contract_address:
    st.error("CONTRACT_ADDRESS is not set. Add it to .streamlit/secrets.toml (or the Streamlit Cloud Secrets box).")
    st.stop()

try:
    ledger = get_ledger(rpc_url, contract_address, start_block)
except Exception as exc:
    st.error(f"Could not connect to the blockchain: {exc}")
    st.stop()


# ---------------------------------------------------------------- live view

@st.fragment(run_every=REFRESH_SECONDS)
def live_view():
    try:
        latest_block = ledger.sync()
        onchain_tally, onchain_total = ledger.contract.functions.getLiveTally().call()
        authorized_count = ledger.contract.functions.getAuthorizedCount().call()
        election_open = ledger.contract.functions.electionOpen().call()
        election_name = ledger.contract.functions.electionName().call()
        block_time = ledger.average_block_time(latest_block)
    except Exception as exc:
        st.error(f"Blockchain read failed (will retry automatically): {exc}")
        return

    # ---- build one row per party: logo, votes and share
    rows = []
    for party_id, votes in enumerate(onchain_tally):
        share = (votes / onchain_total * 100) if onchain_total else 0.0
        rows.append({"id": party_id, "party": ui.party_meta(party_id), "votes": int(votes), "share": share})
    ranked_rows = sorted(rows, key=lambda r: (-r["votes"], r["id"]))

    # ---- banner and headline numbers
    show(ui.banner(election_name, onchain_total))
    show(ui.kpis([
        ("Total ballots cast", ui.fmt_int(onchain_total)),
        ("Voter tokens authorized", ui.fmt_int(authorized_count)),
        ("Avg block confirmation time", f"{block_time:.2f} s"),
        ("Election status", "OPEN" if election_open else "CLOSED"),
    ]))

    # ---- integrity check: log-derived tally vs contract state
    log_tally = [0] * len(onchain_tally)
    for event in ledger.events:
        if event["party_id"] < len(log_tally):
            log_tally[event["party_id"]] += 1
    if log_tally == list(onchain_tally):
        show(ui.status(True, f"Integrity check passed: {ui.fmt_int(len(ledger.events))} VoteCast logs match the contract's stored tally."))
    else:
        show(ui.status(False, "Event logs and contract state differ right now. This usually means a new block is still being indexed."))

    # ---- party results (logos beside votes) and the column chart (logos on bars)
    left, right = st.columns([3, 2])
    with left:
        show(ui.results_table(ranked_rows))
    with right:
        show(ui.column_chart(rows))  # keeps ballot order so the chart does not jump around

    # ---- ballots over time
    if ledger.events:
        events_df = pd.DataFrame(ledger.events).sort_values("timestamp")
        events_df["time"] = pd.to_datetime(events_df["timestamp"], unit="s", utc=True)
        events_df["Cumulative ballots"] = range(1, len(events_df) + 1)

        show(ui.heading("Ballots over time"))
        st.line_chart(events_df.set_index("time")["Cumulative ballots"], height=260)

        if show_ledger:
            with st.expander("Audit ledger (technical details)"):
                latest_df = events_df.sort_values("timestamp", ascending=False).head(15).copy()
                latest_df["Time (UTC)"] = latest_df["time"].dt.strftime("%Y-%m-%d %H:%M:%S")
                latest_df["Party"] = latest_df["party_id"].map(lambda i: ui.party_meta(i)["short"])
                latest_df["Ballot token"] = latest_df["token"].map(lambda t: f"{t[:10]}-{t[-6:]}")
                latest_df["Transaction"] = latest_df["tx_hash"].map(lambda h: f"{explorer_url}/tx/{h}")
                st.dataframe(
                    latest_df[["block", "Time (UTC)", "Party", "Ballot token", "Transaction"]].rename(columns={"block": "Block"}),
                    hide_index=True,
                    use_container_width=True,
                    column_config={"Transaction": st.column_config.LinkColumn("Transaction", display_text="View")},
                )
    else:
        st.info("No ballots have been cast yet. This page will update automatically when the first vote lands on-chain.")

    show(ui.footer(f"Last updated {local_time_text()}  |  Latest block {ui.fmt_int(latest_block)}  |  Refreshes every {REFRESH_SECONDS} seconds"))


live_view()
