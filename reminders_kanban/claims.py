"""Which Hermes has a reminder: the claim line an install writes into its notes.

Two Macs see the same reminders through iCloud, each with its own Hermes. A claim is one line of a
reminder's notes naming the install whose Hermes is working on it. See docs/adr/003-two-macs.md.

Two forms, one parser:
- `Open in Hermes: <task link>`: the task link. New links carry `&mac=<Mac name>` and
  `&t=<start>`.
- `In Hermes on <Mac name> (ref <owner>.<link>.<start>)` ("Only on this Mac", which has no link
  to write): the first eight hex digits of the install id and of the task's link id, and the
  start time.

start is when this install first claimed the reminder for this run, in seconds, base 36. It
never changes while the run lasts: where two claims meet, the earlier one keeps the reminder.

A claim written by a person's Take over here also names the install it took the reminder from,
so it wins over that install's line whatever the times: `&from=<owner>` on the link,
`~<owner>` after the ref. Taking it back again adds a count (`&take=2`, `~2`), so the latest
taker wins. Nothing but Take over writes these.

Ids are compared by their first eight hex digits everywhere (`short`), so both forms of one
claim are the same claim. Older lines still read: full ids in the ref, `, from <id>`,
`, take <n>`, links without a time.
"""

import re
import socket
import subprocess
from urllib.parse import parse_qs, unquote, urlsplit

LINK = "Open in Hermes: "
# How long a new claim sits in the notes before its task may start, on an install that has seen
# another install's claim: time for the other Mac's write to arrive through iCloud.
SETTLE_SECONDS = 15
# The settle window stops applying this long after another install's claim was last seen.
FOREIGN_SEEN_SECONDS = 30 * 24 * 3600

_UUID = r"[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}"
_LINK = re.compile(r"Open in Hermes: (\S+)")
_LINK_LINE = re.compile(r"^Open in Hermes: \S+\s*$")
_LOCAL_OLD = re.compile(
    rf"^In Hermes on (.+) \(ref ({_UUID})\.({_UUID})(?:, from ({_UUID}))?"
    r"(?:, take ([0-9]+))?\)\s*$")
_HEX8 = r"[0-9A-Fa-f]{8}"
_LOCAL = re.compile(
    rf"^In Hermes on (.+) \(ref ({_HEX8})\.({_HEX8})\.([0-9a-z]{{1,10}})"
    rf"(?:~({_HEX8})(?:~([0-9]+))?)?\)\s*$")
_DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz"
_API = re.compile(r"/api/plugins/reminders-kanban/task-links/([^/?#]+)/([^/?#]+)/?$")
_ID = re.compile(r"^[A-Za-z0-9._~-]{1,200}$")

_mac = None


def mac_name():
    """This Mac's name as its owner set it, read once per process."""
    global _mac
    if _mac is None:
        name = ""
        try:
            name = subprocess.run(
                ["/usr/sbin/scutil", "--get", "ComputerName"],
                capture_output=True, text=True, timeout=5, check=False,
            ).stdout
        except (OSError, subprocess.SubprocessError):
            pass
        _mac = clean_mac(name) or clean_mac(socket.gethostname()) or "this Mac"
    return _mac


def clean_mac(name):
    return " ".join(str(name or "").split())


def short(identifier):
    """An id as claims compare it: its first eight characters."""
    return str(identifier or "")[:8].lower()


def base36(number):
    number, text = max(int(number or 0), 0), ""
    while number:
        number, digit = divmod(number, 36)
        text = _DIGITS[digit] + text
    return text or "0"


def _start(text):
    try:
        return int(str(text or "0"), 36)
    except ValueError:
        return 0


def local_line(owner, link, mac, start=0, taken=None, take=0):
    """start: when this run first claimed the reminder. taken: the install a person's Take over
    took it from; take: its place in a chain of take overs (written from the second on)."""
    ref = f"{short(owner)}.{short(link)}.{base36(start)}"
    if taken:
        ref += f"~{short(taken)}" + (f"~{take}" if take > 1 else "")
    return f"In Hermes on {clean_mac(mac) or 'this Mac'} (ref {ref})"


def _take(taken, count):
    """A take over counts as 1 unless it says more; a plain claim as 0."""
    if not taken:
        return 0
    return int(count) if str(count or "").isdigit() and int(count) > 0 else 1


def link_line(url):
    return LINK + url


def _host_name(host):
    """An older link's Mac, from its address's first label. A bare IP or number names nobody."""
    label = host.split(".")[0]
    numeric = not label or label[0].isdigit() or ":" in host or host.replace(".", "").isdigit()
    return "" if numeric else label


def _link_claim(url):
    owner = link = mac = taken = None
    take = start = 0
    named = False
    try:
        parsed = urlsplit(url)
        api = _API.search(parsed.path)
        query = parse_qs(parsed.query)
        if api:
            owner, link = unquote(api.group(1)), unquote(api.group(2))
        elif parsed.path.rstrip("/").endswith("/reminders"):
            owner, link = (query.get(key, [None])[0] for key in ("owner", "link"))
        mac = clean_mac(query.get("mac", [""])[0])
        named = bool(mac)
        mac = mac or _host_name(parsed.hostname or "")
        taken = query.get("from", [None])[0]
        take = _take(taken, query.get("take", [None])[0])
        start = _start(query.get("t", ["0"])[0])
    except ValueError:
        pass
    if not (owner and link and _ID.match(owner) and _ID.match(link)):
        owner = link = None
    if not owner or not taken or not _ID.match(taken):
        taken, take = None, 0
    return dict(owner=short(owner) or None, link=short(link) or None,
                mac=(mac or "another Mac") if owner else None, url=url, named=named,
                start=start if owner else 0, **{"from": short(taken) or None, "take": take})


def claims(notes):
    """Every claim in a reminder's notes, in order:
    [{owner, link, mac, url, start, from, take, line}]. owner, link and from are short ids.

    url is None for the "Only on this Mac" form. owner and link are None for an
    `Open in Hermes:` line whose address names no task: it is kept so nothing treats the reminder
    as unclaimed. line is the whole line when the claim is all of it (so it can be replaced or
    left out), else None.
    """
    found = []
    for line in str(notes or "").split("\n"):
        local, old = _LOCAL.match(line), _LOCAL_OLD.match(line)
        if local or old:
            name, owner, link = (local or old).group(1, 2, 3)
            taken, count = (local.group(5, 6) if local else old.group(4, 5))
            found.append(dict(owner=short(owner), link=short(link), mac=clean_mac(name),
                              url=None, named=True, line=line,
                              start=_start(local.group(4)) if local else 0,
                              **{"from": short(taken) or None, "take": _take(taken, count)}))
            continue
        whole = bool(_LINK_LINE.match(line))
        for url in _LINK.findall(line):
            found.append(dict(_link_claim(url), line=line if whole else None))
    return found


def classify(notes, me, known=lambda link: False, mac=None):
    """A reminder's claims against this install (`me`, its owner id; `known(link)`: a local
    binding exists; `mac`: this Mac's name). kind: none, mine, lost, foreign, or several (more
    than one, or one that can't be read).

    A claim with this install's id, a task it does not know and another Mac's name is foreign:
    the install id was copied to that Mac (a migrated or cloned Hermes home). Only a name the
    claim itself carries counts: an older link's Mac is guessed from its address, which need not
    match this Mac's name."""
    found, me = claims(notes), short(me)
    view = dict(kind="none", mine=[], lost=[], foreign=[], unknown=[])
    for claim in found:
        if not claim["owner"]:
            view["unknown"].append(claim)
        elif claim["owner"] != me:
            view["foreign"].append(claim)
        elif known(claim["link"]):
            view["mine"].append(claim)
        elif mac and claim.get("named") and claim["mac"] != clean_mac(mac):
            view["foreign"].append(claim)
        else:
            view["lost"].append(claim)
    if len(found) == 1 and not view["unknown"]:
        view["kind"] = next(kind for kind in ("mine", "lost", "foreign") if view[kind])
    elif found:
        view["kind"] = "several"
    return view


def _beats(claim, other):
    """A person's take over wins over the claim of the install it names. When each names the
    other (taken, then taken back), the later take over does."""
    if claim["owner"] == other["owner"] or claim.get("from") != other["owner"]:
        return False
    return other.get("from") != claim["owner"] or claim.get("take", 0) > other.get("take", 0)


def holder(found):
    """Among the claims on a reminder, the one that keeps it.

    1. A person's take over beats the claim it names, the latest take first.
    2. Of those left standing, a take over outranks a plain claim it never met (which may be
       a stale line Apple brought back); then the claim that started earlier keeps it: that
       Mac was there first. A claim with no time is from before times were written: earliest.
    3. Equal times: the smallest owner id (then the task id, for a copied install id).

    A pure function of the lines, so every install works out the same answer from the same
    notes, whatever order their writes arrive in and however their clocks differ.
    """
    found = [claim for claim in found if claim.get("owner")]
    standing = [claim for claim in found
                if not any(_beats(other, claim) for other in found)] or found
    return min(standing, key=lambda c: (-c.get("take", 0), c.get("start") or 0, c["owner"],
                                        c.get("link") or "")) if standing else None


def same_but_claims(a, b):
    """Two snapshots of one reminder that differ only by claim lines (and the modified time a
    claim write leaves): to the person it is the same reminder."""
    if not a or not b:
        return False
    plain = [dict(s, notes=strip_claims(s.get("notes")) or None, modified=None) for s in (a, b)]
    return plain[0] == plain[1]


def without_lines(notes, lines):
    """Notes with these whole lines left out, and the blank lines that led up to each."""
    drop = set(lines)
    kept = []
    for line in str(notes or "").split("\n"):
        if line in drop:
            while kept and not kept[-1].strip():
                kept.pop()
        else:
            kept.append(line)
    return "\n".join(kept).rstrip()


def without(notes, drop):
    """Notes without these claims. A claim that is a whole line goes with its line. One a person
    typed onto (`line` None: the link sits inside other text) loses only the link itself, and
    the spaces and tabs left at the ends of that line: the person's words stay."""
    lines = [claim["line"] for claim in drop if claim["line"]]
    tokens = [LINK + claim["url"] for claim in drop if not claim["line"] and claim.get("url")]
    if tokens:
        whole = {claim["line"] for claim in claims(notes) if claim["line"]}
        kept = []
        for line in str(notes or "").split("\n"):
            cut = line
            if line not in whole:
                for token in tokens:
                    cut = cut.replace(token, "")
            if cut == line:
                kept.append(line)
                continue
            cut = cut.strip(" \t")
            if cut:
                kept.append(cut)
            else:
                while kept and not kept[-1].strip():
                    kept.pop()
        notes = "\n".join(kept)
    return without_lines(notes, lines) if lines or tokens else notes or ""


def with_claim(notes, line, drop=()):
    """Notes with `line` as their claim, replacing the lines in `drop`."""
    return (without_lines(notes, drop) if drop else notes or "") + "\n\n" + line


def strip_claims(notes):
    """A reminder's own text: its notes without any claim line. What instructions compare."""
    return without_lines(notes, [c["line"] for c in claims(notes) if c["owner"] and c["line"]])
