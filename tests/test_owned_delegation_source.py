import copy

import pytest
from owned_delegation_source import OwnedSource
from test_delegation import setup  # noqa: F401


def test_activation_ignores_unowned_ready_source(setup):  # noqa: F811
    service, source, owner, admission = setup
    other = dict(source.rows[0], id="other", title="[Agent · Ready] Unrelated")
    source.rows.append(copy.deepcopy(other))
    service.call = OwnedSource(source, "a")
    service.write_link = lambda *_: pytest.fail("activation must not write a link")
    assert service.preview()["eligible"] == []
    result = service.apply("activate")
    assert result["tasks"] == []
    assert not owner.tasks and admission.starts == 0
    assert source.rows[1] == other and source.writes == 0


@pytest.mark.parametrize("op,fields", [
    ("read", {"id": "other"}),
    ("complete-occurrence", {"expected": {"id": "other"}}),
    ("delegation-link", {"id": "a", "expected": {"id": "other"}}),
])
def test_rejects_unowned_target_before_helper_call(op, fields):
    source = OwnedSource(lambda *_args, **_kwargs: pytest.fail("unowned access"), "a")
    with pytest.raises(ValueError, match="recorded fixture"):
        source(op, **fields)
