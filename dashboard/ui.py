# dashboard/ui.py
# Pure HTML/CSS builders for the results dashboard. This file does NOT import Streamlit,
# so it can be tested on its own. app.py calls these functions and shows the result.
import base64
import html
from pathlib import Path

# Sampled from the IEC logo's blue cube. To match the IEC website banner exactly,
# colour-pick the banner on results.elections.org.za and change the next two lines.
IEC_BLUE = "#0078C4"
IEC_BLUE_DARK = "#005A96"

LOGO_DIR = Path(__file__).parent / "assets" / "logos"

# Order MUST match the party ids in the smart contract and the voter app.
PARTIES = [
    {"short": "ANC", "name": "African National Congress", "color": "#1B8F3A", "logo": "anc"},
    {"short": "DA", "name": "Democratic Alliance", "color": "#1D6FD1", "logo": "da"},
    {"short": "MK", "name": "uMkhonto weSizwe Party", "color": "#3F3F46", "logo": "mk"},
    {"short": "EFF", "name": "Economic Freedom Fighters", "color": "#D7191C", "logo": "eff"},
    {"short": "IFP", "name": "Inkatha Freedom Party", "color": "#E0A100", "logo": "ifp"},
    {"short": "FF Plus", "name": "Freedom Front Plus", "color": "#F26A1B", "logo": "ffplus"},
    {"short": "ActionSA", "name": "Action South Africa", "color": "#19B230", "logo": "actionsa"},
    {"short": "PA", "name": "Patriotic Alliance", "color": "#C8222A", "logo": "pa"},
]


def party_meta(party_id):
    """Display details for a party id, with a safe fallback for ids we have no logo for."""
    if party_id < len(PARTIES):
        return PARTIES[party_id]
    return {"short": f"Party {party_id}", "name": f"Party {party_id}", "color": "#64748B", "logo": None}


# ----------------------------------------------------------------------------- helpers

_logo_cache = {}


def logo_uri(key):
    """Returns the logo as a data: URI so it can be embedded straight into the page."""
    if key is None:
        return None
    if key not in _logo_cache:
        path = LOGO_DIR / f"{key}.png"
        if path.exists():
            _logo_cache[key] = "data:image/png;base64," + base64.b64encode(path.read_bytes()).decode("ascii")
        else:
            _logo_cache[key] = None
    return _logo_cache[key]


def _one_line(markup):
    """Streamlit's markdown engine can break HTML at blank lines or indentation, so we flatten it."""
    return "".join(line.strip() for line in markup.strip().splitlines())


def fmt_int(value):
    """South African style thousands separator: 1 234 567."""
    return f"{int(value):,}".replace(",", " ")


def _logo_img(party, css_class):
    """A logo box. The picture itself comes from the .lg-<name> CSS class defined once in css()."""
    if logo_uri(party["logo"]):
        label = html.escape(party["short"])
        return f'<span class="{css_class} lg-{party["logo"]}" role="img" aria-label="{label} logo"></span>'
    initials = html.escape(party["short"][:3])
    return f'<span class="{css_class} noimg">{initials}</span>'


# ----------------------------------------------------------------------------- CSS

_CSS = """
<style>
#MainMenu, footer, header[data-testid="stHeader"] {display: none !important;}
.stApp, [data-testid="stAppViewContainer"] {background: #EEF3F8; overflow-x: hidden;}
.block-container {padding-top: 0 !important; padding-bottom: 3rem; max-width: 1200px;}
.iec-banner {background: __BLUE__; color: #fff; width: 100vw; margin-left: calc(50% - 50vw);
  box-shadow: 0 3px 8px rgba(0,0,0,.25); border-bottom: 4px solid __DARK__;}
.iec-inner {max-width: 1200px; margin: 0 auto; padding: 14px 24px; display: flex; align-items: center;
  justify-content: space-between; gap: 18px; flex-wrap: wrap;}
.iec-left {display: flex; align-items: center; gap: 16px;}
.logo-tile {background: #fff; border-radius: 12px; padding: 6px; width: 76px; height: 76px; display: flex;
  align-items: center; justify-content: center; box-shadow: 0 2px 6px rgba(0,0,0,.25);}
.iec-img {width: 100%; height: 100%;}
.iec-title {font-size: 1.7rem; line-height: 1.15; font-weight: 400;}
.iec-title b {font-weight: 800;}
.iec-sub {margin-top: 6px; font-size: .8rem; letter-spacing: .14em; font-weight: 700; display: flex;
  align-items: center; gap: 8px;}
.live-dot {width: 10px; height: 10px; border-radius: 50%; background: #FF4D4D; display: inline-block;
  animation: pulse 1.6s infinite;}
@keyframes pulse {0% {box-shadow: 0 0 0 0 rgba(255,77,77,.7);} 70% {box-shadow: 0 0 0 9px rgba(255,77,77,0);}
  100% {box-shadow: 0 0 0 0 rgba(255,77,77,0);}}
.iec-right {text-align: right;}
.iec-right .big {font-size: 2.6rem; font-weight: 800; line-height: 1;}
.iec-right .small {font-size: .75rem; letter-spacing: .14em; opacity: .9; margin-top: 4px;}
.notice {background: #FFF4CC; color: #6B5300; font-size: .82rem; padding: 7px 14px; text-align: center;
  border-radius: 0 0 8px 8px; margin-bottom: 4px;}
.kpis {display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin: 18px 0 12px;}
.kpi {background: #fff; border-radius: 10px; padding: 14px 18px; box-shadow: 0 1px 4px rgba(15,40,70,.12);
  border-top: 4px solid __BLUE__;}
.kpi .label {font-size: .74rem; letter-spacing: .08em; text-transform: uppercase; color: #5B6B7C; font-weight: 700;}
.kpi .value {font-size: 1.9rem; font-weight: 800; color: #0F2F4F; margin-top: 4px;}
.status {border-radius: 8px; padding: 9px 14px; font-size: .88rem; margin-bottom: 16px;}
.status.ok {background: #E3F5E8; color: #14532D;}
.status.warn {background: #FFF1D6; color: #7A4A00;}
.panel {background: #fff; border-radius: 10px; padding: 16px 18px 14px; box-shadow: 0 1px 4px rgba(15,40,70,.12);}
.panel-h {font-size: 1.05rem; font-weight: 800; color: __BLUE__; border-bottom: 2px solid #E3EAF2;
  padding-bottom: 8px; margin-bottom: 8px;}
.panel-sub {font-size: .78rem; color: #6B7C8D; margin: -4px 0 8px;}
.rhead, .row {display: grid; grid-template-columns: 26px 46px minmax(110px, 1.3fr) 2fr 84px 76px; gap: 10px;
  align-items: center;}
.rhead {font-size: .72rem; letter-spacing: .08em; text-transform: uppercase; color: #6B7C8D; font-weight: 700;
  padding: 4px 0;}
.rhead .num, .row .num {text-align: right;}
.row {padding: 8px 0; border-top: 1px solid #EDF2F7;}
.row .rank {color: #8A99A8; font-weight: 700; text-align: center;}
.plogo, .clogo, .iec-img {display: inline-block; background-repeat: no-repeat; background-position: center; background-size: contain;}
.plogo {width: 42px; height: 42px; border-radius: 8px;}
.noimg {display: inline-flex; align-items: center; justify-content: center; background: #E3EAF2; color: #44566A;
  font-weight: 800; font-size: .75rem;}
.pname b {display: block; color: #0F2F4F; font-size: .98rem;}
.pname span {display: block; color: #6B7C8D; font-size: .74rem; line-height: 1.2;}
.track {background: #EDF2F7; border-radius: 6px; height: 14px; overflow: hidden;}
.fill {height: 100%; border-radius: 6px; min-width: 2px;}
.row .num {font-variant-numeric: tabular-nums; font-weight: 700; color: #0F2F4F;}
.cols {display: flex; align-items: flex-end; gap: 8px; height: 320px; padding-top: 6px;}
.col {flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: flex-end; align-items: center;}
.clogo {width: 38px; height: 38px; border-radius: 8px; margin-bottom: 4px;}
.cbar {width: 100%; max-width: 46px; border-radius: 6px 6px 0 0; min-height: 3px;}
.cval {font-size: .72rem; font-weight: 700; color: #0F2F4F; margin-bottom: 3px;}
.clabel {font-size: .68rem; color: #44566A; margin-top: 5px; text-align: center; font-weight: 700;}
.foot {text-align: center; color: #6B7C8D; font-size: .78rem; margin-top: 22px;}
@media (max-width: 800px) {
  .kpis {grid-template-columns: repeat(2, 1fr);}
  .iec-title {font-size: 1.25rem;}
  .iec-right {text-align: left;}
  .rhead, .row {grid-template-columns: 22px 40px 1fr 70px 62px;}
  .rhead .bar-col, .row .track {display: none;}
}
</style>
"""


def css():
    """Page styling plus every logo as a CSS class. Rendered once, so refreshes stay small."""
    base = _CSS.replace("__BLUE__", IEC_BLUE).replace("__DARK__", IEC_BLUE_DARK)
    keys = [p["logo"] for p in PARTIES] + ["iec"]
    logo_rules = "\n".join(
        f'.lg-{key} {{background-image: url("{logo_uri(key)}");}}' for key in keys if logo_uri(key)
    )
    return _one_line(base.replace("</style>", logo_rules + "\n</style>"))


# ----------------------------------------------------------------------------- builders

def banner(election_name, total_ballots):
    tile = '<span class="iec-img lg-iec" role="img" aria-label="IEC logo"></span>' if logo_uri("iec") else "IEC"
    return _one_line(f"""
<div class="iec-banner"><div class="iec-inner">
<div class="iec-left"><div class="logo-tile">{tile}</div>
<div><div class="iec-title"><b>{html.escape(election_name)}</b> Results</div>
<div class="iec-sub"><span class="live-dot"></span>LIVE RESULTS</div></div></div>
<div class="iec-right"><div class="big">{fmt_int(total_ballots)}</div><div class="small">BALLOTS COUNTED</div></div>
</div></div>
<div class="notice">Unofficial prototype on a test blockchain. Not affiliated with, or endorsed by, the Electoral Commission of South Africa.</div>
""")


def kpis(items):
    """items = list of (label, value) pairs."""
    cards = "".join(
        f'<div class="kpi"><div class="label">{html.escape(label)}</div><div class="value">{html.escape(str(value))}</div></div>'
        for label, value in items
    )
    return f'<div class="kpis">{cards}</div>'


def status(ok, text):
    return f'<div class="status {"ok" if ok else "warn"}">{html.escape(text)}</div>'


def results_table(rows):
    """rows = list of dicts with: party (meta dict), votes, share. Sorted by the caller."""
    head = (
        '<div class="rhead"><span></span><span></span><span>Party</span>'
        '<span class="bar-col">Support</span><span class="num">Votes</span><span class="num">% Support</span></div>'
    )
    body = ""
    for rank, row in enumerate(rows, start=1):
        party = row["party"]
        body += (
            '<div class="row">'
            f'<span class="rank">{rank}</span>'
            f'{_logo_img(party, "plogo")}'
            f'<div class="pname"><b>{html.escape(party["short"])}</b><span>{html.escape(party["name"])}</span></div>'
            f'<div class="track"><div class="fill" style="width:{row["share"]:.2f}%;background:{party["color"]}"></div></div>'
            f'<span class="num">{fmt_int(row["votes"])}</span>'
            f'<span class="num">{row["share"]:.2f}%</span>'
            "</div>"
        )
    return (
        '<div class="panel"><div class="panel-h">Party results</div>'
        '<div class="panel-sub">Each party logo sits next to its votes. Ranked by votes.</div>'
        f"{head}{body}</div>"
    )


def column_chart(rows):
    """Vertical bars with each party logo on top of its bar."""
    cols = ""
    leader = max((r["share"] for r in rows), default=0) or 1  # tallest bar always fills the chart
    for row in rows:
        party = row["party"]
        height = max(3, int(row["share"] / leader * 210))
        cols += (
            '<div class="col">'
            f'<div class="cval">{row["share"]:.1f}%</div>'
            f'{_logo_img(party, "clogo")}'
            f'<div class="cbar" style="height:{height}px;background:{party["color"]}"></div>'
            f'<div class="clabel">{html.escape(party["short"])}</div>'
            "</div>"
        )
    return (
        '<div class="panel"><div class="panel-h">National vote share</div>'
        f'<div class="cols">{cols}</div></div>'
    )


def heading(text):
    """A section heading in the dashboard's own colours, readable in light or dark browser themes."""
    return f'<div class="panel-h" style="margin-top:20px">{html.escape(text)}</div>'


def footer(updated_text):
    return f'<div class="foot">{html.escape(updated_text)}</div>'
