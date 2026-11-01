"""Longbox Arc Finder: issue summaries and story-arc tracking from Metron."""

from __future__ import annotations

import re
from datetime import date

import mokkari
import streamlit as st
from mokkari.exceptions import ApiError, AuthenticationError, RateLimitError

st.set_page_config(page_title="Longbox Arc Finder", page_icon="📚", layout="centered")

MAX_RANGE = 25  # issues fetched in one run (Metron allows ~30 requests a minute)
TTL = 60 * 60 * 12  # cache Metron answers for 12 hours


# ---------------------------------------------------------------- Metron access
def metron_token() -> str:
    try:
        return str(st.secrets.get("METRON_TOKEN", "")).strip()
    except Exception:  # no secrets file at all
        return ""


@st.cache_resource
def _session(token: str) -> mokkari.session.Session:
    return mokkari.api(token, user_agent="LongboxArcFinder/1.0")


def metron() -> mokkari.session.Session:
    return _session(metron_token())


def call(fn, *args):
    """Run a Metron call and turn its failures into readable messages."""
    try:
        return fn(*args)
    except RateLimitError:
        st.error("Metron's rate limit was hit. Wait a minute and try again.")
    except AuthenticationError:
        st.error("Metron rejected the token. Check `METRON_TOKEN` in Secrets.")
    except ApiError as e:
        st.error(f"Metron returned an error: {e}")
    st.stop()


@st.cache_data(ttl=TTL, show_spinner=False)
def find_series(name: str, publisher: str, year: str) -> list[dict]:
    params: dict[str, str | int] = {"name": name}
    if publisher:
        params["publisher_name"] = publisher
    if year.isdigit():
        params["year_began"] = int(year)
    rows = call(metron().series_list, params)
    return [
        {
            "id": s.id,
            "label": f"{s.display_name} · {s.publisher.name} · {s.issue_count} issues",
            "name": s.display_name,
            "publisher": s.publisher.name,
        }
        for s in rows
    ]


@st.cache_data(ttl=TTL, show_spinner=False)
def series_issues(series_id: int) -> list[dict]:
    rows = call(metron().issues_list, {"series_id": series_id})
    return [_base(i) for i in rows]


@st.cache_data(ttl=TTL, show_spinner=False)
def issue_detail(issue_id: int) -> dict:
    i = call(metron().issue, issue_id)
    if i is None:
        return {}
    writers = [c.creator for c in i.credits if any(r.name.lower() == "writer" for r in c.role)]
    artists = [
        c.creator
        for c in i.credits
        if any(r.name.lower() in {"artist", "penciller"} for r in c.role)
    ]
    return {
        "id": i.id,
        "number": i.number,
        "series": i.series.name,
        "titles": [t for t in i.story_titles if t],
        "desc": (i.desc or "").strip(),
        "solicit": i.desc_is_solicitation,
        "arcs": [{"id": a.id, "name": a.name} for a in i.arcs],
        "cover_date": i.cover_date,
        "store_date": i.store_date,
        "image": str(i.image) if i.image else None,
        "url": str(i.resource_url),
        "writers": writers[:3],
        "artists": artists[:3],
    }


@st.cache_data(ttl=TTL, show_spinner=False)
def arc_info(arc_id: int) -> tuple[dict, list[dict]]:
    a = call(metron().arc, arc_id)
    issues = call(metron().arc_issues_list, arc_id)
    meta = {"name": a.name if a else "Story arc", "desc": (a.desc if a else "") or ""}
    ordered = sorted((_base(i) for i in issues), key=lambda r: (r["cover_date"], r["id"]))
    return meta, ordered


def _base(i) -> dict:
    return {
        "id": i.id,
        "number": i.number,
        "name": i.issue_name,
        "series": i.series.name,
        "series_id": i.series.id,
        "cover_date": i.cover_date,
        "store_date": i.store_date,
        "image": str(i.image) if i.image else None,
    }


# ---------------------------------------------------------------- helpers
def num_key(n: str) -> float:
    """Sort/compare issue numbers like '1', '12.1', '0', '½'."""
    if n.strip() == "½":
        return 0.5
    m = re.match(r"-?\d+(\.\d+)?", n.strip())
    return float(m.group()) if m else float("inf")


def fmt(d: date | None) -> str:
    return d.strftime("%-d %b %Y") if d else "date unknown"


def pick_series(prefix: str) -> dict | None:
    c1, c2, c3 = st.columns([3, 2, 1.3])
    title = c1.text_input("Comic title", "Batman", key=f"{prefix}-title")
    pub = c2.text_input("Publisher", "DC Comics", key=f"{prefix}-pub")
    year = c3.text_input("Start year", "2011", key=f"{prefix}-year", help="Optional. Separates relaunched volumes.")
    if not title.strip():
        return None
    with st.spinner("Searching Metron…"):
        matches = find_series(title.strip(), pub.strip(), year.strip())
    if not matches and year.strip():
        st.caption("No match with that start year. Showing all years.")
        matches = find_series(title.strip(), pub.strip(), "")
    if not matches:
        st.warning("Metron has no series with that title and publisher. Check the spelling.")
        return None
    return st.selectbox("Series", matches, format_func=lambda s: s["label"], key=f"{prefix}-series")


def issue_card(d: dict, badge: str = "") -> None:
    with st.container(border=True):
        left, right = st.columns([1, 4])
        if d.get("image"):
            left.image(d["image"], use_container_width=True)
        else:
            left.markdown(f"### #{d['number']}")
        title = " / ".join(d.get("titles") or []) or "Untitled"
        head = f"**{d['series']} #{d['number']}**: {title}"
        if badge:
            head = f"`{badge}` " + head
        right.markdown(head)
        bits = [f"Cover {fmt(d['cover_date'])}"]
        if d.get("store_date"):
            bits.append(f"On sale {fmt(d['store_date'])}")
        if d.get("arcs"):
            bits.append("Arc: " + ", ".join(a["name"] for a in d["arcs"]))
        right.caption(" · ".join(bits))
        if d.get("desc"):
            right.write(d["desc"])
            if d.get("solicit"):
                right.caption("Publisher solicitation text.")
        else:
            right.caption(f"No synopsis on Metron yet. [Open on Metron]({d['url']})")


# ---------------------------------------------------------------- page
st.title("Longbox Arc Finder")
st.caption("Issue summaries and story arcs from the Metron comics database.")

if not metron_token():
    st.error(
        "No Metron token found. Add `METRON_TOKEN` to the app's Secrets "
        "(Streamlit Community Cloud → your app → Settings → Secrets). "
        "You can generate a token on your metron.cloud account page."
    )
    st.stop()

run_tab, arc_tab = st.tabs(["Summarize a run", "Where does the arc end?"])

with run_tab:
    series = pick_series("run")
    if series:
        c1, c2 = st.columns(2)
        start = c1.number_input("Start issue #", min_value=0, value=1, step=1, key="run-start")
        end = c2.number_input("End issue #", min_value=0, value=7, step=1, key="run-end")
        if st.button("Summarize issues", type="primary", key="run-go"):
            lo, hi = sorted((start, end))
            with st.spinner("Pulling the issue list…"):
                pool = series_issues(series["id"])
            chosen = sorted(
                (i for i in pool if lo <= num_key(i["number"]) <= hi),
                key=lambda i: (num_key(i["number"]), i["cover_date"]),
            )
            if not chosen:
                st.warning(f"Metron lists no issues #{lo}–{hi} for this series.")
            else:
                if len(chosen) > MAX_RANGE:
                    st.info(f"Showing the first {MAX_RANGE} of {len(chosen)} issues to stay inside Metron's rate limit.")
                    chosen = chosen[:MAX_RANGE]
                bar = st.progress(0.0, "Reading issues…")
                details = []
                for n, i in enumerate(chosen, 1):
                    details.append(issue_detail(i["id"]))
                    bar.progress(n / len(chosen), f"Reading #{i['number']}…")
                bar.empty()

                arcs: dict[str, list[str]] = {}
                for d in details:
                    for a in d["arcs"]:
                        arcs.setdefault(a["name"], []).append(d["number"])
                st.subheader(f"{series['name']} #{chosen[0]['number']}–{chosen[-1]['number']}")
                st.write(f"{len(details)} issues · {len(arcs)} story arc{'s' if len(arcs) != 1 else ''}")
                if arcs:
                    st.table(
                        [
                            {"Arc": name, "Issues in this run": f"#{nums[0]}–#{nums[-1]}" if len(nums) > 1 else f"#{nums[0]}", "Count": len(nums)}
                            for name, nums in arcs.items()
                        ]
                    )
                for d in details:
                    issue_card(d)

with arc_tab:
    series = pick_series("arc")
    if series:
        number = st.text_input("Issue #", "3", key="arc-num")
        if st.button("Find the arc", type="primary", key="arc-go"):
            st.session_state["arc-query"] = (series["id"], number.strip())
        q = st.session_state.get("arc-query")
        if q and q[0] == series["id"]:
            with st.spinner("Finding the issue…"):
                pool = series_issues(series["id"])
                hit = next((i for i in pool if i["number"] == q[1]), None) or next(
                    (i for i in pool if num_key(i["number"]) == num_key(q[1])), None
                )
            if not hit:
                st.warning(f"Metron has no issue #{q[1]} in this series.")
            else:
                cur = issue_detail(hit["id"])
                if not cur["arcs"]:
                    st.info("Metron doesn't list this issue as part of a story arc. It may be a standalone, or the arc hasn't been entered yet.")
                    issue_card(cur, "You are here")
                else:
                    arc = cur["arcs"][0]
                    if len(cur["arcs"]) > 1:
                        arc = st.selectbox("This issue is in several arcs. Pick one:", cur["arcs"], format_func=lambda a: a["name"])
                    with st.spinner("Loading the arc…"):
                        meta, parts = arc_info(arc["id"])
                    ids = [p["id"] for p in parts]
                    pos = ids.index(cur["id"]) if cur["id"] in ids else -1
                    following = parts[pos + 1 :] if pos >= 0 else []
                    finale = parts[-1] if parts else None

                    st.subheader(meta["name"])
                    if meta["desc"]:
                        st.write(meta["desc"])
                    m1, m2, m3 = st.columns(3)
                    m1.metric("Issues in arc", len(parts))
                    m2.metric("Part", f"{pos + 1} of {len(parts)}" if pos >= 0 else "?")
                    m3.metric("Still to read", len(following))
                    if finale:
                        when = finale["store_date"] or finale["cover_date"]
                        upcoming = finale["store_date"] and finale["store_date"] > date.today()
                        verb = "Concludes" if upcoming else "Concluded"
                        st.success(
                            f"**{verb} in {finale['series']} #{finale['number']}**, "
                            f"{'on sale' if finale['store_date'] else 'cover date'} {fmt(when)}"
                            + (" (not out yet)" if upcoming else "")
                        )
                    crossover = {p["series"] for p in parts} - {cur["series"]}
                    if crossover:
                        st.caption("Crosses over into: " + ", ".join(sorted(crossover)))

                    issue_card(cur, "You are here")
                    if not following:
                        st.info("This is the last issue of the arc.")
                    else:
                        st.markdown("#### Still to read")
                        with_synopses = st.toggle(
                            "Show synopses", value=len(following) <= 12,
                            help="Loads each issue from Metron (one request per issue).",
                        )
                        for n, p in enumerate(following):
                            badge = "Finale" if n == len(following) - 1 else ""
                            if with_synopses:
                                issue_card(issue_detail(p["id"]), badge)
                            else:
                                st.markdown(
                                    f"{'`Finale` ' if badge else ''}**{p['series']} #{p['number']}**: {p['name'] or ''} · {fmt(p['store_date'] or p['cover_date'])}"
                                )

st.divider()
st.caption("Data from [Metron](https://metron.cloud), the community comic book database. Missing synopses or arcs can be added there.")
