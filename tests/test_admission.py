import sqlite3
from types import SimpleNamespace

import pytest

from reminders_kanban.execution import UnsupportedControl
from reminders_kanban.execution.admission import Admission, positive


@pytest.mark.parametrize(('raw', 'expected'), [(None, None), (0, None), (-1, None),
                                              (True, None), ('bad', None), ('4', 4)])
def test_positive(raw, expected):
    assert positive(raw) == expected


@pytest.mark.parametrize(('host', 'adjusted', 'host_board_cap', 'expected'), [
    (None, None, None, (None, 3, 3)),
    (5, None, None, (5, 5, 5)),
    (5, 7, None, (5, 7, 5)),
    (5, 2, None, (5, 2, 2)),
    (None, 7, 2, (None, 7, 2)),
])
def test_limits(host, adjusted, host_board_cap, expected):
    a = Admission.__new__(Admission)
    a.config = lambda: {'kanban': {'dispatch_in_gateway': False,
                                 'max_in_progress': host, 'max_spawn': host_board_cap}}
    a.dispatch = SimpleNamespace(review_dispatch_enabled=lambda: False,
                                 resolve_max_in_progress=lambda value: value)
    conn = sqlite3.connect(':memory:')
    conn.execute('CREATE TABLE rk_settings (key TEXT, value INTEGER)')
    if adjusted:
        conn.execute("INSERT INTO rk_settings VALUES ('maximum', ?)", (adjusted,))
    assert a._settings(conn)[1:] == expected
    a.dispatch.review_dispatch_enabled = lambda: True
    with pytest.raises(UnsupportedControl):
        a._settings(conn)


@pytest.mark.live
def test_host_contract_in_disposable_home(tmp_path):
    """Uses real owner transactions/claims, never real credentials or workers."""
    import os
    import subprocess
    from pathlib import Path

    interpreter = Path.home() / '.hermes/hermes-agent/venv/bin/python'
    if not interpreter.exists():
        pytest.skip('installed Hermes compatibility check unavailable')
    result = subprocess.run([str(interpreter), 'tests/admission_host_contract.py'],
                            capture_output=True, text=True, timeout=30,
                            env={**{k: v for k, v in os.environ.items()
                                    if not k.startswith('HERMES_KANBAN_')},
                                 'HERMES_HOME': str(tmp_path / 'home'),
                                 'HERMES_KANBAN_HOME': str(tmp_path / 'kanban')})
    assert result.returncode == 0, result.stdout + result.stderr
