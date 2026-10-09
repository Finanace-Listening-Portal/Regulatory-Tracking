"""
Streamlit wrapper for the Finance Listening Portal (regulatory_tracker_live.html).

The HTML page normally fetches ./data/regulatory_data.json, which doesn't work
inside Streamlit's embedded frame. This app reads that JSON in Python (latest
copy from GitHub, falling back to the copy deployed with the app) and injects
it into the page, so the portal looks and works exactly like the GitHub Pages
version.
"""
import json
from pathlib import Path

import requests
import streamlit as st
import streamlit.components.v1 as components

REPO = "Finanace-Listening-Portal/Regulatory-Tracking"
BRANCH = "main"
HTML_FILE = "regulatory_tracker_live.html"
DATA_FILE = "data/regulatory_data.json"
RAW_URL = f"https://raw.githubusercontent.com/{REPO}/{BRANCH}/{DATA_FILE}"

BASE_DIR = Path(__file__).parent

st.set_page_config(
    page_title="Finance Listening Portal",
    page_icon="📊",
    layout="wide",
    initial_sidebar_state="collapsed",
)

# Remove Streamlit's padding/header so the portal fills the page
st.markdown(
    """
    <style>
      #MainMenu, header, footer {visibility: hidden;}
      .block-container {padding: 0 !important; max-width: 100% !important;}
      iframe {display: block;}
    </style>
    """,
    unsafe_allow_html=True,
)


@st.cache_data(ttl=900, show_spinner="Loading latest regulatory data…")
def load_data() -> str:
    """Return the data JSON as text: latest from GitHub, else the local copy."""
    try:
        r = requests.get(RAW_URL, timeout=30)
        if r.status_code == 200:
            json.loads(r.text)  # validate
            return r.text
    except (requests.RequestException, ValueError):
        pass
    local = BASE_DIR / DATA_FILE
    if local.exists():
        return local.read_text(encoding="utf-8")
    return ""


@st.cache_data
def load_html() -> str:
    return (BASE_DIR / HTML_FILE).read_text(encoding="utf-8")


def build_page(html: str, data_json: str) -> str:
    if not data_json:
        return html
    # Make the JSON safe to place inside a <script> tag
    safe = data_json.replace("</", "<\\/")
    inject = f"<script>window.__EMBEDDED_DATA__ = {safe};</script>"

    # Use the embedded data instead of fetching ./data/regulatory_data.json
    html = html.replace(
        "async function loadStaticData(force = false) {",
        "async function loadStaticData(force = false) {\n"
        "  if (window.__EMBEDDED_DATA__) { staticData = window.__EMBEDDED_DATA__; "
        "staticDataError = null; return staticData; }",
        1,
    )
    if "<head>" in html:
        return html.replace("<head>", "<head>" + inject, 1)
    return inject + html


page = build_page(load_html(), load_data())
components.html(page, height=2200, scrolling=True)
