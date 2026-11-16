import copy
import json
import subprocess

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from test_delegation import setup as one_off_setup  # noqa: F401
from test_occurrence import setup as recurring_setup  # noqa: F401
from test_recurring import enable

from reminders_kanban.api import link_setup
from reminders_kanban.links.setup import Setup, check, tailscale
from reminders_kanban.reminders.helper import HelperError

HOST = 'mac.tail1234.ts.net'
ADDRESS = f'https://{HOST}:8443'
LOCAL = 'http://127.0.0.1:9119'
# Sanitized shapes captured in the design proof; no real CLI is invoked.
STATUS = dict(BackendState='Running', Self={'DNSName': HOST + '.'}, CertDomains=[HOST])
SERVE = {'TCP': {'443': {'HTTPS': True}}, 'Web': {
    f'{HOST}:443': {'Handlers': {'/': {'Proxy': 'http://127.0.0.1:8787'}}}}}


class Host:
    def __init__(self):
        self.status = copy.deepcopy(STATUS)
        self.serve = copy.deepcopy(SERVE)
        self.providers = ['basic']
        self.gated = False
        self.commands = []
        self.funnel = False

    def fetch(self, address, host=None):
        return 200, dict(version='1', auth_required=self.gated,
                         auth_providers=self.providers)

    def run(self, binary, *args):
        self.commands.append(args)
        if args == ('status', '--json'):
            return json.dumps(self.status)
        if args == ('serve', 'status', '--json'):
            return json.dumps(self.serve)
        port = next(arg.split('=')[1] for arg in args if arg.startswith('--https='))
        key = f'{HOST}:{port}'
        if args[-1] == 'off':
            self.serve['Web'].pop(key, None)
            self.serve['TCP'].pop(port, None)
        else:
            assert self.gated
            assert args[-1] == LOCAL
            self.serve['Web'][key] = {'Handlers': {'/': {'Proxy': LOCAL}}}
            self.serve['TCP'][port] = {'HTTPS': True}
            self.serve['AllowFunnel'] = {key: self.funnel}
        return ''


@pytest.fixture
def setup(tmp_path):
    host = Host()
    config = tmp_path / 'config.yaml'
    config.write_text('# keep this\nmodel: example\ndashboard:\n  port: 9119 # keep port\n')
    owner = Setup(tmp_path, fetch=host.fetch, run=host.run, binary=lambda: 'fixture', env={})
    app = FastAPI()
    app.include_router(link_setup.router)
    app.dependency_overrides[link_setup.service] = lambda: owner
    return owner, host, TestClient(app)


def test_read_only_get_and_local(setup):
    owner, host, client = setup
    before = owner.path.read_bytes()
    response = client.get('/task-links/setup')
    assert response.headers['cache-control'] == 'no-store'
    assert response.json()['tailscale']['port'] == 8443
    assert not (owner.home / 'reminders-kanban').exists()
    assert client.post('/task-links/setup/local', json={}).json() == {'status': 'local'}
    assert client.get('/task-links/setup').json()['status'] == 'local'
    assert owner.path.read_bytes() == before
    assert all(args[-1] == '--json' for args in host.commands)


@pytest.mark.parametrize('state,certs,expected', [
    ('Running', [HOST], 'ready'), ('NeedsLogin', [HOST], 'signed_out'),
    ('Stopped', [HOST], 'signed_out'), ('Running', [], 'https_off')])
def test_tailscale_states(setup, state, certs, expected):
    owner, host, _ = setup
    host.status.update(BackendState=state, CertDomains=certs)
    assert owner.inspect()['tailscale']['state'] == expected
    assert tailscale(None, host.run, LOCAL)['state'] == 'not_installed'


def test_cli_error_and_existing_handler(setup):
    owner, host, _ = setup
    def failed(*args):
        raise subprocess.TimeoutExpired('fixture', 5)
    assert tailscale('fixture', failed, LOCAL)['state'] == 'unknown'
    host.gated = True
    assert owner.apply('tailscale', expected=ADDRESS)['status'] == 'ready'
    before = len([a for a in host.commands if '--bg' in a])
    assert owner.inspect()['tailscale']['existing']
    assert owner.apply('tailscale', expected=ADDRESS)['status'] == 'ready'
    assert len([a for a in host.commands if '--bg' in a]) == before


def test_restart_order_backup_undo(setup):
    owner, host, client = setup
    before = owner.path.read_bytes()
    result = client.post('/task-links/setup/apply', json={
        'mode': 'tailscale', 'expected': ADDRESS}).json()
    assert result['status'] == 'restart_needed'
    assert not any('--bg' in args for args in host.commands)
    assert '# keep this' in owner.path.read_text() and '# keep port' in owner.path.read_text()
    host.gated = True
    assert owner.apply('tailscale', expected=ADDRESS)['status'] == 'ready'
    assert owner.undo()['status'] == 'undone'
    assert owner.path.read_bytes() == before
    assert host.serve['Web'] == SERVE['Web']


@pytest.mark.parametrize('refusal', ['env_override', 'no_signin', 'stale'])
def test_refuse_before_writing(setup, refusal):
    owner, host, _ = setup
    before = owner.path.read_bytes()
    expected = ADDRESS
    if refusal == 'env_override':
        owner.env['HERMES_DASHBOARD_PUBLIC_URL'] = ADDRESS
    elif refusal == 'no_signin':
        host.providers = []
    else:
        expected = 'https://changed.ts.net'
    assert owner.apply('tailscale', expected=expected)['status'] == refusal
    assert owner.path.read_bytes() == before


def test_funnel_rollback_and_edited_config(setup):
    owner, host, _ = setup
    host.gated = host.funnel = True
    assert owner.apply('tailscale', expected=ADDRESS)['status'] == 'funnel_on'
    assert f'{HOST}:8443' not in host.serve['Web']
    owner.path.write_text(owner.path.read_text() + '# edit\n')
    assert owner.undo()['status'] == 'changed_since'


@pytest.mark.parametrize('address,status', [
    ('http://example.com', 'not_https'), ('https://localhost', 'loopback'),
    ('https://127.0.0.1', 'loopback'), ('https://example.com/a', 'has_path'),
    ('https://user:secret@example.com', 'has_credentials'),
    ('https://example.com:bad', 'not_https'), ('https://example.com', 'password_on_public')])
def test_origin_validation(address, status):
    assert check(address, Host().fetch)['status'] == status


@pytest.mark.parametrize('code,body,status', [
    (0, {}, 'unreachable'), (400, {}, 'restart_needed'), (200, {}, 'other_server'),
    (401, {}, 'other_server'),
    (200, {'auth_required': True, 'auth_providers': []}, 'no_signin'),
    (401, {'auth_required': True, 'auth_providers': ['nous']}, 'ok'),
    (200, {'auth_required': True, 'auth_providers': ['oidc']}, 'ok')])
def test_probe_results(code, body, status):
    assert check(ADDRESS, lambda _: (code, body))['status'] == status


@pytest.mark.parametrize('fixture', ['one_off_setup', 'recurring_setup'])
@pytest.mark.parametrize('case', ['normal', 'lost_response', 'before_write', 'completed', 'edited'])
def test_local_and_backfill(request, fixture, case):
    service, source, worker, admission = request.getfixturevalue(fixture)
    Setup(service.home, env={}).local()
    service.origin = None
    if fixture == 'one_off_setup':
        assert service.apply('activate')['status'] == 'ok'
    row = service.apply('ready', expected=copy.deepcopy(source.rows[0]))['tasks'][0]
    service.apply('tick')
    assert admission.starts == 1
    assert row['destination']['url'] is None
    # "Only on this Mac" writes no link, only the line that says which Mac's Hermes has it.
    owner_id, link_id = row['destination']['owner_id'], row['destination']['link_id']
    assert source.rows[0]['notes'].startswith(
        f'My notes\n\nIn Hermes on {service.mac} (ref {owner_id[:8]}.{link_id[:8]}.')
    assert 'Open in Hermes:' not in source.rows[0]['notes']
    identity = (row['destination']['owner_id'], row['destination']['link_id'])
    if case == 'completed':
        source.rows[0]['completed'] = True
    elif case == 'edited':
        source.rows[0]['notes'] += '\nUser edit'
    elif case in {'lost_response', 'before_write'}:
        def uncertain(expected, notes):
            if case == 'lost_response':
                source.link(expected, notes)
            raise HelperError('uncertain', 'response lost')
        service.write_link = uncertain
    service.backfill_links(ADDRESS)
    service.write_link = source.link
    service.backfill_links(ADDRESS)
    current = service.preview()['tasks'][0]
    assert (current['destination']['owner_id'], current['destination']['link_id']) == identity
    if case in {'completed', 'edited'}:
        assert 'Open in Hermes:' not in source.rows[0]['notes']
        assert current['backfill'] == ('completed' if case == 'completed' else 'conflict')
    else:
        assert source.rows[0]['notes'].count('Open in Hermes:') == 1
        worker.tasks[row['task_id']] = 'result'
        service.apply('tick')
        args = (dict(expected=copy.deepcopy(source.rows[0])) if fixture == 'one_off_setup'
                else dict(occurrence_id=row['key']))
        service.apply('accept', **args)
        assert source.writes == 1


def test_every_occurrence_local_and_backfill(recurring_setup):  # noqa: F811
    service, source, worker, admission = recurring_setup
    Setup(service.home, env={}).local()
    service.origin = None
    first = enable(recurring_setup)
    assert first['destination']['url'] is None and admission.starts == 1
    service.backfill_links(ADDRESS)
    service.origin = ADDRESS
    worker.tasks[first['task_id']] = 'result'
    service.apply('accept', occurrence_id=first['key'])
    service.apply('tick')
    rows = service.preview()['tasks']
    assert len(rows) == 2
    assert rows[1]['destination'] == rows[0]['destination']
    assert source.rows[0]['notes'].count('Open in Hermes:') == 1


def test_activation_refusal_and_preview(one_off_setup):  # noqa: F811
    service, _, _, _ = one_off_setup
    for origin, reason in [(None, 'task_link_origin_missing'),
                           ('http://localhost', 'task_link_origin_invalid')]:
        service.origin = origin
        assert service.apply('activate') == dict(status='setup_required', reason=reason)
        assert service.preview()['task_links']['status'] in {'missing', 'invalid'}


def test_real_https_probe(tmp_path, monkeypatch):
    import ssl
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer

    from reminders_kanban.links.setup import probe

    cert, key = tmp_path / 'cert.pem', tmp_path / 'key.pem'
    subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                    '-keyout', str(key), '-out', str(cert), '-days', '1',
                    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'],
                   check=True, capture_output=True)
    monkeypatch.setenv('SSL_CERT_FILE', str(cert))
    replies = [(200, {'auth_required': True, 'auth_providers': ['nous']}),
               (400, {}), (401, {'auth_required': True, 'auth_providers': ['oidc']}),
               (200, {}), (302, {})]
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            requests.append(dict(self.headers))
            code, body = replies.pop(0)
            self.send_response(code)
            self.send_header('Location', '/must-not-follow')
            self.end_headers()
            self.wfile.write(json.dumps(body).encode())

        def log_message(self, *args):
            pass

    server = HTTPServer(('127.0.0.1', 0), Handler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert, key)
    server.socket = context.wrap_socket(server.socket, server_side=True)
    thread = threading.Thread(target=server.serve_forever)
    thread.start()
    try:
        for status in ['ok', 'restart_needed', 'ok', 'other_server', 'other_server']:
            assert check(ADDRESS, lambda _: probe(
                f'https://localhost:{server.server_port}'))['status'] == status
        assert len(requests) == 5
        assert all('Authorization' not in r and 'Cookie' not in r for r in requests)
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def test_handler_only_undo(setup):
    owner, host, _ = setup
    owner.path.write_text(owner.path.read_text() + f'  public_url: {ADDRESS}\n')
    before = owner.path.read_bytes()
    host.gated = True
    assert owner.apply('tailscale', expected=ADDRESS)['status'] == 'ready'
    assert owner.undo()['status'] == 'undone'
    assert owner.path.read_bytes() == before
    assert host.serve['Web'] == SERVE['Web']


def test_funnel_rollback_restores_config_without_undo(setup):
    owner, host, _ = setup
    before = owner.path.read_bytes()
    host.gated = host.funnel = True
    assert owner.apply('tailscale', expected=ADDRESS)['status'] == 'funnel_on'
    assert owner.path.read_bytes() == before
    assert owner.readiness()['status'] == 'missing'
    assert not (owner.home / 'reminders-kanban/link-setup.json').exists()


def test_delegation_discovery_does_not_probe_on_controls(setup, monkeypatch):
    from reminders_kanban.api import delegation

    owner, host, _ = setup
    monkeypatch.setattr(
        delegation, 'Admission', lambda home: type('Admission', (), {'board': 'fixture'})())
    monkeypatch.setattr('reminders_kanban.links.setup.probe', host.fetch)
    monkeypatch.setattr('reminders_kanban.links.setup.command', host.run)
    calls = []
    def fetch(*args):
        calls.append(args)
        return host.fetch(*args)
    monkeypatch.setattr('reminders_kanban.links.setup.Setup', lambda home: owner)
    owner.fetch = fetch
    service = delegation.service(owner.home)
    assert service is not None
    assert calls == [] and host.commands == []
    assert service.link_readiness()['status'] == 'missing'
    assert calls == [] and host.commands == []
    owner.path.write_text(owner.path.read_text() + f'  public_url: {ADDRESS}\n')
    owner.readiness()
    assert len(calls) == 1 and host.commands == []


def test_undo_address_change_retains_previous_serve(setup):
    owner, host, _ = setup
    host.gated = True
    assert owner.apply('tailscale', expected=ADDRESS)['status'] == 'ready'
    previous = owner.path.read_bytes()
    host.providers = ['nous']
    assert owner.apply('own', address='https://hermes.example')['status'] == 'ready'
    assert owner.undo()['status'] == 'undone'
    assert owner.path.read_bytes() == previous
    assert host.serve['Web'][f'{HOST}:8443']['Handlers']['/'] == {'Proxy': LOCAL}


def test_owner_tick_switches_local_after_address_becomes_ready(one_off_setup):  # noqa: F811
    service, source, _, _ = one_off_setup
    host = Host()
    setup_service = Setup(service.home, fetch=host.fetch, run=host.run,
                          binary=lambda: 'fixture', env={})
    setup_service.local()
    service.origin = None
    service.link_setup = setup_service
    service.apply('activate')
    row = service.apply('ready', expected=copy.deepcopy(source.rows[0]))['tasks'][0]
    assert row['destination']['url'] is None
    setup_service.path.write_text(f'dashboard:\n  public_url: {ADDRESS}\n')
    service.apply('tick')
    assert 'Open in Hermes:' not in source.rows[0]['notes']
    host.gated = True
    service.apply('tick')
    assert source.rows[0]['notes'].count('Open in Hermes:') == 1
    assert service.preview()['task_links']['mode'] == 'links'
    assert not host.commands


def test_cli_path_honors_sandbox_override(monkeypatch):
    from reminders_kanban.links import setup

    monkeypatch.setenv("RK_TAILSCALE_CLI", "/tmp/fixture-tailscale")
    assert setup.cli_path() == "/tmp/fixture-tailscale"
    monkeypatch.setenv("RK_TAILSCALE_CLI", "")
    assert setup.cli_path() is None


def test_delegation_get_does_not_wait_for_hanging_address(one_off_setup):  # noqa: F811
    import threading
    import time

    from reminders_kanban.api import delegation

    service, _, _, _ = one_off_setup
    path = service.home / 'config.yaml'
    path.write_text(f'dashboard:\n  public_url: {ADDRESS}\n')
    started, release, finished = threading.Event(), threading.Event(), threading.Event()
    calls = []

    def hanging(address):
        calls.append(address)
        started.set()
        release.wait(3)
        finished.set()
        return 0, {}

    app = FastAPI()
    app.include_router(delegation.router)

    def owner():
        # Real requests construct a fresh Setup each time.
        service.link_setup = Setup(service.home, fetch=hanging, env={})
        return service

    app.dependency_overrides[delegation.service] = owner
    try:
        with TestClient(app) as client:
            start = time.monotonic()
            for _ in range(4):
                result = client.get('/delegation')
                assert result.status_code == 200
                assert result.json()['task_links']['status'] == 'restart_needed'
            assert time.monotonic() - start < 0.5
            assert started.wait(1)
            assert calls == [ADDRESS]
    finally:
        release.set()
        assert finished.wait(1)


def test_probe_cache_ttl_address_and_fresh_inspection(setup, monkeypatch):
    import threading
    from types import SimpleNamespace

    from reminders_kanban.links import setup as module

    owner, host, client = setup
    owner.path.write_text(f'dashboard:\n  public_url: {ADDRESS}\n')
    clock = [10]
    monkeypatch.setattr(module, 'time', SimpleNamespace(monotonic=lambda: clock[0]))
    host.gated = True
    assert owner.readiness()['status'] == 'ready'
    host.gated = False
    assert owner.readiness(fresh=False)['status'] == 'ready'
    assert client.get('/task-links/setup').json()['status'] == 'restart_needed'
    host.gated = True
    checked = client.post('/task-links/setup/check', json={'address': ADDRESS}).json()
    assert checked['status'] == 'ok'
    assert owner.readiness(fresh=False)['status'] == 'restart_needed'
    done = threading.Event()
    original = owner.fetch

    def fetch(*args):
        try:
            return original(*args)
        finally:
            done.set()

    # Seed the cache for this fetch, then expire it.
    owner.fetch = fetch
    owner.readiness()
    done.clear()
    clock[0] += module.PROBE_TTL + 1
    owner.readiness(fresh=False)
    assert done.wait(1)
    # A changed address cannot inherit ready from the previous one.
    release = threading.Event()
    def blocked(*args):
        release.wait(1)
        return 0, {}
    owner.fetch = blocked
    owner.path.write_text('dashboard:\n  public_url: https://new.ts.net\n')
    try:
        assert owner.readiness(fresh=False)['status'] == 'restart_needed'
        assert owner.readiness(fresh=False)['address'] == 'https://new.ts.net'
    finally:
        release.set()


@pytest.mark.parametrize('failure', ['stale_before', 'stale_after', 'command_error', 'funnel'])
@pytest.mark.parametrize('edited', [False, True])
def test_apply_refusal_rolls_back_only_owned_changes(setup, failure, edited):
    owner, host, _ = setup
    owner.local()
    state_path = owner.home / 'reminders-kanban/link-setup.json'
    state_before = state_path.read_bytes()
    before = owner.path.read_bytes()
    host.gated = True
    host.funnel = failure == 'funnel'
    original_run = host.run
    status_reads = 0

    def run(binary, *args):
        nonlocal status_reads
        if args == ('status', '--json'):
            status_reads += 1
            if status_reads == 2 and failure == 'stale_before':
                if edited:
                    owner.path.write_bytes(owner.path.read_bytes() + b'# edit\n')
                host.status['BackendState'] = 'Stopped'
        result = original_run(binary, *args)
        if '--bg' in args:
            if edited:
                owner.path.write_bytes(owner.path.read_bytes() + b'# edit\n')
            if failure == 'stale_after':
                host.serve['Web'][f'{HOST}:8443']['Handlers']['/'] = {'Proxy': 'http://other'}
            if failure == 'command_error':
                raise subprocess.TimeoutExpired('fixture', 5)
        return result

    owner.run = run
    if failure == 'command_error':
        with pytest.raises(subprocess.TimeoutExpired):
            owner.apply('tailscale', expected=ADDRESS)
    else:
        assert owner.apply('tailscale', expected=ADDRESS)['status'] == (
            'funnel_on' if failure == 'funnel' else 'stale')
    if edited:
        assert owner.path.read_bytes().endswith(b'# edit\n')
        assert ADDRESS in owner.path.read_text()
    else:
        assert owner.path.read_bytes() == before
    assert state_path.read_bytes() == state_before
    assert host.serve['Web'][f'{HOST}:443'] == SERVE['Web'][f'{HOST}:443']
    if failure == 'stale_after':
        assert host.serve['Web'][f'{HOST}:8443']['Handlers']['/'] == {'Proxy': 'http://other'}
    else:
        assert f'{HOST}:8443' not in host.serve['Web']


def test_funnel_refusal_preserves_reused_handler(setup):
    owner, host, _ = setup
    host.gated = True
    host.serve['Web'][f'{HOST}:8443'] = {'Handlers': {'/': {'Proxy': LOCAL}}}
    host.serve['TCP']['8443'] = {'HTTPS': True}
    original = host.fetch
    before = owner.path.read_bytes()

    def fetch(address, host_header=None):
        if host_header:
            host.serve['AllowFunnel'] = {f'{HOST}:8443': True}
        return original(address, host_header)

    owner.fetch = fetch
    assert owner.apply('tailscale', expected=ADDRESS)['status'] == 'funnel_on'
    assert owner.path.read_bytes() == before
    assert host.serve['Web'][f'{HOST}:8443']['Handlers']['/'] == {'Proxy': LOCAL}
    assert not any(args[-1] == 'off' for args in host.commands)


def test_apply_publishes_fresh_ready_to_preview_cache(setup):
    owner, host, _ = setup
    owner.path.write_text(f'dashboard:\n  public_url: {ADDRESS}\n')
    assert owner.readiness()['status'] == 'restart_needed'
    host.gated = True
    assert owner.apply('tailscale', expected=ADDRESS)['status'] == 'ready'
    assert owner.readiness(fresh=False)['status'] == 'ready'


def test_refusal_restores_absent_config(setup):
    owner, host, _ = setup
    owner.path.unlink()
    host.gated = host.funnel = True
    assert owner.apply('tailscale', expected=ADDRESS)['status'] == 'funnel_on'
    assert not owner.path.exists()


def test_old_background_probe_cannot_replace_fresh_result(setup):
    import threading

    owner, host, _ = setup
    owner.path.write_text(f'dashboard:\n  public_url: {ADDRESS}\n')
    entered, release = threading.Event(), threading.Event()
    threads = []

    def fetch(address):
        if threading.current_thread() is not threading.main_thread():
            threads.append(threading.current_thread())
            entered.set()
            release.wait(2)
            return 0, {}
        return 200, dict(auth_required=True, auth_providers=['basic'])

    owner.fetch = fetch
    try:
        owner.readiness(fresh=False)
        assert entered.wait(1)
        assert owner.readiness()['status'] == 'ready'
    finally:
        release.set()
        for thread in threads:
            thread.join(1)
    assert owner.readiness(fresh=False)['status'] == 'ready'


def test_final_probe_exception_rolls_back_apply(setup):
    owner, host, client = setup
    host.gated = True
    before = owner.path.read_bytes()

    def fetch(address, host_header=None):
        if address == ADDRESS:
            raise OSError('fixture probe failed')
        return host.fetch(address, host_header)

    owner.fetch = fetch
    result = client.post('/task-links/setup/apply', json={
        'mode': 'tailscale', 'expected': ADDRESS}).json()
    assert result['status'] == 'unavailable'
    assert owner.path.read_bytes() == before
    assert host.serve['Web'] == SERVE['Web']
    assert not (owner.home / 'reminders-kanban/link-setup.json').exists()


def test_apply_keeps_quoted_values_other_readers_depend_on(setup):
    # Hermes reads config.yaml as YAML 1.1, where a bare off is False, not the string 'off'.
    owner, host, _ = setup
    owner.path.write_text("approvals:\n  mode: 'off'\n  ask: \"yes\"\ndashboard:\n  port: 9119\n")
    host.gated = True
    assert owner.apply('tailscale', expected=ADDRESS)['status'] == 'ready'
    saved = owner.path.read_text()
    assert "mode: 'off'" in saved and 'ask: "yes"' in saved
    assert f'public_url: {ADDRESS}' in saved
