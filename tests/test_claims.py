from reminders_kanban import claims as module
from reminders_kanban.claims import (
    claims,
    classify,
    holder,
    local_line,
    strip_claims,
    with_claim,
    without_lines,
)
from reminders_kanban.links import Links, link_url
from reminders_kanban.reminders.completion import instructions
from reminders_kanban.workflow.reconciliation import check_identity
from reminders_kanban.workflow.source import instructions as guard_instructions

ME = "11111111-1111-4111-8111-111111111111"
OTHER = "22222222-2222-4222-8222-222222222222"
LINK = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
LINK2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
THIRD = "33333333-3333-4333-8333-333333333333"
PLAIN = {"from": None, "take": 0, "named": True}
START = 1794000000


def test_reads_both_claim_forms():
    url = link_url("https://studio.tail.ts.net", OTHER, LINK, "default", "Nicky's Mac Studio",
                   start=START)
    assert url.endswith("&mac=Nicky%27s+Mac+Studio&t=to3n9c")
    local = local_line(ME, LINK2, "MacBook Pro (155)", START)
    # Short on the phone: eight hex digits of the install, eight of the task, the start time.
    assert local == "In Hermes on MacBook Pro (155) (ref 11111111.bbbbbbbb.to3n9c)"
    found = claims(f"Book it\n\nOpen in Hermes: {url}\n\n{local}")
    assert found == [
        dict(owner="22222222", link="aaaaaaaa", mac="Nicky's Mac Studio", url=url,
             line=f"Open in Hermes: {url}", start=START, **PLAIN),
        dict(owner="11111111", link="bbbbbbbb", mac="MacBook Pro (155)", url=None, line=local,
             start=START, **PLAIN),
    ]
    assert claims(None) == claims("") == claims("Just notes") == []


def test_every_older_form_still_reads():
    old = f"In Hermes on Studio (ref {OTHER}.{LINK})"
    assert claims(old) == [dict(owner="22222222", link="aaaaaaaa", mac="Studio", url=None,
                                line=old, start=0, **PLAIN)]
    took = claims(f"In Hermes on Studio (ref {OTHER}.{LINK}, from {ME}, take 2)")[0]
    assert (took["owner"], took["from"], took["take"], took["start"]) == (
        "22222222", "11111111", 2, 0)
    assert claims(f"In Hermes on Studio (ref {OTHER}.{LINK}, from {ME})")[0]["take"] == 1
    link = f"https://a.example/reminders?owner={OTHER}&link={LINK}&profile=default"
    plain = claims(f"Open in Hermes: {link}")[0]
    assert (plain["owner"], plain["start"], plain["from"]) == ("22222222", 0, None)
    older = claims(f"Open in Hermes: {link}&mac=Air&from={ME}&take=2")[0]
    assert (older["from"], older["take"], older["mac"]) == ("11111111", 2, "Air")
    # Both forms of one claim are the same claim.
    compact = claims(local_line(OTHER, LINK, "Studio", START))[0]
    assert (compact["owner"], compact["link"]) == (plain["owner"], plain["link"])
    assert strip_claims(f"Book it\n\n{old}") == "Book it"


def test_old_link_without_mac_is_named_by_its_host():
    old = link_url("https://studio.tail.ts.net", OTHER, LINK, "default")
    assert "mac=" not in old and "t=" not in old
    assert claims(f"Open in Hermes: {old}")[0]["mac"] == "studio"
    # A bare address names nobody.
    for host in ("100.101.5.9", "4.example.com", "[fd7a::1]"):
        bare = f"https://{host}/reminders?owner={OTHER}&link={LINK}"
        assert claims(f"Open in Hermes: {bare}")[0]["mac"] == "another Mac"
    api = f"https://air.example/api/plugins/reminders-kanban/task-links/{OTHER}/{LINK}"
    assert claims(f"Open in Hermes: {api}")[0] == dict(
        owner="22222222", link="aaaaaaaa", mac="air", url=api, line=f"Open in Hermes: {api}",
        start=0, **dict(PLAIN, named=False))


def test_text_that_only_looks_like_a_claim():
    # An address that names no task is kept as an unreadable claim, never as nobody's.
    assert claims("Open in Hermes: https://other.example/task")[0]["owner"] is None
    assert claims("Open in Hermes: Settings > Account")[0]["line"] is None
    assert claims("In Hermes on Studio (ref not-a-ref)") == []
    assert claims("In Hermes on Studio (ref 1234567.abcdef12.x)") == []
    assert claims(f"See: {local_line(ME, LINK, 'Studio', START)}") == []
    inline = claims(f"Go to Open in Hermes: {link_url('https://a.example', ME, LINK, 'p')} now")
    assert inline[0]["owner"] == ME[:8] and inline[0]["line"] is None


def test_classification():
    def known(link):
        return link == LINK[:8]

    mine = local_line(ME, LINK, "Air", START)
    lost = local_line(ME, LINK2, "Air", START)
    foreign = local_line(OTHER, LINK, "Studio", START)
    assert classify(None, ME, known)["kind"] == "none"
    assert classify(f"n\n\n{mine}", ME, known)["kind"] == "mine"
    assert classify(f"n\n\n{lost}", ME, known)["kind"] == "lost"
    assert classify(f"n\n\n{foreign}", ME, known)["kind"] == "foreign"
    both = classify(f"n\n\n{mine}\n\n{foreign}", ME, known)
    assert both["kind"] == "several" and len(both["mine"]) == len(both["foreign"]) == 1
    assert classify("Open in Hermes: https://x.example/y", ME, known)["kind"] == "several"
    # An install that never delegated has no id: every claim is another install's.
    assert classify(f"n\n\n{mine}", None)["kind"] == "foreign"


def claim(owner, start=0, taken=None, take=0):
    return {"owner": owner[:8], "start": start, "from": taken[:8] if taken else None,
            "take": take if taken else 0}


def test_the_earlier_claim_keeps_the_reminder():
    early, late = claim(OTHER, 100), claim(ME, 200)
    # Whoever was there first, whatever the ids and whatever order the lines come in.
    assert holder([early, late]) == holder([late, early]) == early
    assert holder([claim(ME, 100), claim(OTHER, 200)])["owner"] == ME[:8]
    # Claimed in the same second: the smallest id.
    assert holder([claim(OTHER, 100), claim(ME, 100)])["owner"] == ME[:8]
    # A line from before times were written was there before any that has one.
    assert holder([claim(OTHER), claim(ME, 100)])["owner"] == OTHER[:8]
    assert holder([claim(OTHER), claim(ME)])["owner"] == ME[:8]
    assert holder([]) is None


def test_a_take_over_names_whom_it_took_from():
    local = local_line(OTHER, LINK, "Air", START, ME)
    assert local == "In Hermes on Air (ref 22222222.aaaaaaaa.to3n9c~11111111)"
    again = local_line(ME, LINK2, "Studio", START, OTHER, 2)
    assert again == "In Hermes on Studio (ref 11111111.bbbbbbbb.to3n9c~22222222~2)"
    url = link_url("https://air.example", OTHER, LINK, "default", "Air", ME, start=START)
    assert url.endswith(f"&mac=Air&t=to3n9c&from={ME}")
    url2 = link_url("https://s.example", ME, LINK2, "default", "Studio", OTHER, 2, START)
    assert url2.endswith(f"&t=to3n9c&from={OTHER}&take=2")
    found = claims(f"n\n\n{local}\n\n{again}\n\nOpen in Hermes: {url}\nOpen in Hermes: {url2}")
    assert [(c["owner"], c["from"], c["take"], c["start"]) for c in found] == [
        ("22222222", "11111111", 1, START), ("11111111", "22222222", 2, START)] * 2
    assert claims(local_line(ME, LINK, "Air", START))[0]["take"] == 0
    assert strip_claims(f"Book it\n\n{again}") == "Book it"


def test_a_persons_take_over_beats_time_and_id():
    old, taker = claim(ME, 100), claim(OTHER, 900, ME, 1)
    # The taker keeps it though it is later and its id larger, in any order.
    assert holder([old, taker]) == holder([taker, old]) == taker
    # Taken back: the latest taker, whatever lines survive.
    back = claim(ME, 950, OTHER, 2)
    assert holder([old, taker, back]) == holder([taker, back]) == holder([back, old, taker]) == back
    # Each names the other with nothing to tell them apart: time, then the smallest id.
    assert holder([taker, claim(ME, 950, OTHER, 1)]) == taker
    assert holder([claim(OTHER, 5, ME, 1), claim(ME, 5, OTHER, 1)])["owner"] == ME[:8]
    # Three installs: the one taken from is out; a take over outranks a plain claim it never
    # met (a stale line Apple brought back), however early that one is.
    assert holder([old, taker, claim(THIRD, 50)]) == taker
    # A ring of three decides nothing: time, then id.
    ring = [claim(ME, 7, THIRD, 1), claim(OTHER, 7, ME, 1), claim(THIRD, 7, OTHER, 1)]
    assert holder(ring)["owner"] == ME[:8]


def test_same_reminder_but_for_claims():
    from reminders_kanban.claims import same_but_claims

    line = local_line(ME, LINK, "Air", START)
    before = dict(id="a", title="T", notes=f"Book it\n\n{line}", modified="m1", due=None)
    assert same_but_claims(before, dict(before, notes="Book it", modified="m2"))
    assert same_but_claims(dict(before, notes=f"\n\n{line}"), dict(before, notes=None))
    assert not same_but_claims(before, dict(before, notes="Book it now"))
    assert not same_but_claims(before, dict(before, title="Other"))
    assert not same_but_claims(before, None)


def test_claim_lines_are_not_instructions():
    line = local_line(OTHER, LINK, "Studio")
    link = "Open in Hermes: " + link_url("https://a.example", ME, LINK2, "default", "Air")
    assert strip_claims(f"Book it\n\n{line}\n\n{link}") == "Book it"
    assert strip_claims(f"Book it\n\n{line}\nand more") == "Book it\nand more"
    assert strip_claims(f"\n\n{link}") == ""
    assert strip_claims("Open in Hermes: https://other.example/task") == (
        "Open in Hermes: https://other.example/task")
    plain = dict(title="T", notes=None, url=None)
    claimed = dict(plain, notes=f"\n\n{link}")
    assert instructions(plain) == instructions(claimed)
    assert guard_instructions(plain) == guard_instructions(claimed)
    assert instructions(dict(plain, notes="Book it")) != instructions(claimed)
    # A stored comparison from before claims were left out reads the same once normalized.
    assert instructions(dict(title="T", notes=f"Book it\n\n{link}", url=None)) == instructions(
        instructions(dict(title="T", notes="Book it", url=None)))


def test_editing_notes_touches_only_claim_lines():
    a, b = local_line(ME, LINK, "Air"), local_line(OTHER, LINK2, "Studio")
    assert with_claim(None, a) == f"\n\n{a}"
    assert with_claim("Book it", a) == f"Book it\n\n{a}"
    assert with_claim(f"Book it\n\n{b}", a, [b]) == f"Book it\n\n{a}"
    assert without_lines(f"Book it\n\n{a}\n\n{b}", [b]) == f"Book it\n\n{a}"
    assert without_lines(f"Book it\n\n{b}\n\n{a}", [b]) == f"Book it\n\n{a}"


def test_identity_holds_only_this_installs_claims():
    own = local_line(ME, LINK, "Air")
    row = dict(id="a", externalId="x", calendarId="l", completed=False, notes=f"n\n\n{own}")
    other = dict(row, notes=row["notes"] + "\n\n" + local_line(OTHER, LINK2, "Studio"))
    assert check_identity(row, [other], ME) is None
    assert check_identity(row, [other]) == "conflicting_links"
    twice = dict(row, notes=row["notes"] + "\n\n" + local_line(ME, LINK2, "Air"))
    assert check_identity(row, [twice], ME) == "conflicting_links"
    copy = dict(row, id="b", externalId="y")
    assert check_identity(row, [row, copy], ME) == "multiple_candidates"
    # A link written after an "Only on this Mac" line is the same claim.
    linked = dict(row, notes="n\n\nOpen in Hermes: " + link_url("https://a.example", ME, LINK, "p"))
    assert check_identity(row, [linked], ME) is None


def test_install_identity(tmp_path, monkeypatch):
    links = Links(tmp_path)
    assert links.owner_id(create=False) is None and not links.path.exists()
    assert not links.seen_foreign() and not links.known(LINK)
    owner = links.owner_id()
    assert links.owner_id() == owner == Links(tmp_path).owner_id(create=False)
    assert links.bind("reminder", "occurrence", "board", "task", "default")[0] == owner
    links.mark_foreign()
    assert Links(tmp_path).seen_foreign()

    calls = []

    def scutil(command, **_):
        calls.append(command)
        return type("Done", (), {"stdout": "  Nicky's\nMac Studio \n"})()

    monkeypatch.setattr(module, "_mac", None)
    monkeypatch.setattr(module.subprocess, "run", scutil)
    assert module.mac_name() == module.mac_name() == "Nicky's Mac Studio"
    assert calls == [["/usr/sbin/scutil", "--get", "ComputerName"]]
    monkeypatch.setattr(module, "_mac", None)
    monkeypatch.setattr(module.subprocess, "run", lambda *_, **__: (_ for _ in ()).throw(OSError()))
    monkeypatch.setattr(module.socket, "gethostname", lambda: "studio.local")
    assert module.mac_name() == "studio.local"
    monkeypatch.setattr(module, "_mac", None)


def test_only_plain_digits_count_a_take_over():
    line = "In Hermes on A (ref 8115b29f.c245465c.to3n9c~aaaaaaaa~٣)"
    assert claims(line) == []
