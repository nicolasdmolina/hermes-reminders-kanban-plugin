"""Subprocess boundaries must not inherit the gateway's provider credentials."""
import ast
import os
from pathlib import Path
from unittest.mock import patch

import pytest

from reminders_kanban.process_env import child_env
from reminders_kanban.reminders import helper, helper_setup


def test_children_receive_only_platform_essentials_and_explicit_inputs():
    source = dict(PATH='/usr/bin:/bin', HOME='/tmp/test-home', TMPDIR='/tmp/test-tmp',
                  DEVELOPER_DIR='/test/developer', OPENAI_API_KEY='test-secret',
                  ANTHROPIC_API_KEY='test-secret', RK_UNRELATED_SECRET='test-secret',
                  RK_ARCHIVE_PASSPHRASE='stale-secret', HERMES_HOME='/wrong/profile',
                  PYTHONPATH='/untrusted', DYLD_INSERT_LIBRARIES='/untrusted')
    with patch.dict(os.environ, source, clear=True):
        assert child_env() == {key: source[key] for key in
                               ('PATH', 'HOME', 'TMPDIR', 'DEVELOPER_DIR')}
        env = child_env(RK_ARCHIVE_PASSPHRASE='one-time', HERMES_HOME='/chosen/profile')
        assert env['RK_ARCHIVE_PASSPHRASE'] == 'one-time'
        assert env['HERMES_HOME'] == '/chosen/profile'
        assert 'OPENAI_API_KEY' not in env
    with pytest.raises(ValueError, match='Unsupported'):
        child_env(OPENAI_API_KEY='test-secret')


def test_empty_parent_has_a_safe_command_search_path():
    with patch.dict(os.environ, {}, clear=True):
        assert child_env() == {'PATH': os.defpath}


def test_setup_and_helper_inspection_commands_use_filtered_environments():
    with patch.dict(os.environ, {'OPENAI_API_KEY': 'test-secret'}), \
            patch('subprocess.run') as run:
        helper_setup._run(['/usr/bin/xcode-select', '-p'])
        assert run.call_args.kwargs['env'] == child_env()
        helper_setup._run(['/usr/bin/openssl'], env={'RK_ARCHIVE_PASSPHRASE': 'one-time'})
        assert run.call_args.kwargs['env'] == child_env(RK_ARCHIVE_PASSPHRASE='one-time')
        run.return_value.stderr = 'Authority=Test signing identity'
        helper._verify(Path('/synthetic/helper.app'), 'A' * 40)
        helper.still_running('/synthetic/request')
        for call in run.call_args_list:
            assert 'OPENAI_API_KEY' not in call.kwargs['env']


def test_every_runtime_subprocess_boundary_supplies_an_environment():
    # Catches new paths that silently revert to Python's inherited environment default.
    root = Path(__file__).resolve().parents[1] / 'reminders_kanban'
    for relative in ('reminders/helper.py', 'reminders/helper_setup.py', 'links/setup.py'):
        tree = ast.parse((root / relative).read_text())
        for node in ast.walk(tree):
            if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                    and isinstance(node.func.value, ast.Name)
                    and node.func.value.id == 'subprocess'
                    and node.func.attr in {'run', 'Popen', 'check_output', 'check_call', 'call'}):
                assert any(kw.arg == 'env' for kw in node.keywords), (relative, node.lineno)
