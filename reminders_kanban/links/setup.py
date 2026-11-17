"""Explicit task-link setup. All host mutations are confined to POST operations."""

import fcntl
import json
import os
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlsplit

from reminders_kanban.links import origin_error
from reminders_kanban.process_env import child_env


def read_state(home):
    path = home / 'reminders-kanban/link-setup.json'
    return json.loads(path.read_text()) if path.exists() else {}


def atomic(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def save_state(home, state):
    atomic(home / 'reminders-kanban/link-setup.json', json.dumps(state).encode())


@contextmanager
def setup_lock(home):
    directory = home / 'reminders-kanban'
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / 'link-setup.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def probe(address, host=None):
    """Fresh opener: no ambient proxies, cookies, authorization or redirects."""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    request = urllib.request.Request(address.rstrip('/') + '/api/status',
                                     headers={'Host': host} if host else {})
    try:
        response = opener.open(request, timeout=5)
    except urllib.error.HTTPError as exc:
        response = exc
    except (OSError, ValueError):
        return 0, {}
    with response:
        try:
            body = json.loads(response.read(1024 * 1024))
        except (ValueError, OSError):
            body = {}
        return response.code, body if isinstance(body, dict) else {}


def signin(body):
    providers = body.get('auth_providers', [])
    return next((label for key, label in [('nous', 'nous'), ('oidc', 'oidc'),
                                         ('basic', 'password')] if key in providers), None)


def check(address, fetch=probe):
    error = origin_error(address)
    if error:
        return dict(status=error)
    code, body = fetch(address)
    if code == 400:
        return dict(status='restart_needed')
    if not code:
        return dict(status='unreachable')
    if code not in {200, 401} or 'auth_required' not in body or 'auth_providers' not in body:
        return dict(status='other_server')
    provider = signin(body)
    if not provider:
        return dict(status='no_signin')
    if provider == 'password' and not urlsplit(address).hostname.endswith('.ts.net'):
        return dict(status='password_on_public', signin=provider)
    if body.get('auth_required') is not True:
        return dict(status='restart_needed', signin=provider)
    return dict(status='ok', signin=provider)


# Shared by request-scoped Setup instances; one current address per dashboard home.
_probe_cache = {}
_probe_lock = threading.Lock()
PROBE_TTL = 15


def cached_check(home, address, fetch, *, fresh):
    key = (address, fetch)
    with _probe_lock:
        entry = _probe_cache.get(home)
        if entry is None or entry['key'] != key or fresh:
            entry = dict(key=key, result=dict(status='unreachable'), expires=0, pending=False)
            _probe_cache[home] = entry
        if not fresh and (entry['pending'] or entry['expires'] > time.monotonic()):
            return entry['result']
        entry['pending'] = True

    def refresh():
        result = dict(status='unreachable')
        try:
            result = check(address, fetch)
        except Exception:
            if fresh:
                raise
        finally:
            with _probe_lock:
                entry.update(result=result, expires=time.monotonic() + PROBE_TTL, pending=False)
        return result

    if fresh:
        return refresh()
    threading.Thread(target=refresh, daemon=True, name='task-link-probe').start()
    return entry['result']


def cli_path():
    # Sandbox proofs point this at a fixture CLI; set but empty means "not installed".
    if 'RK_TAILSCALE_CLI' in os.environ:
        return os.environ['RK_TAILSCALE_CLI'] or None
    app = Path('/Applications/Tailscale.app/Contents/MacOS/Tailscale')
    return str(app) if app.is_file() else shutil.which('tailscale')


def command(binary, *args):
    return subprocess.run([binary, *args], check=True, capture_output=True,
                          text=True, timeout=5, env=child_env()).stdout


def tailscale(binary, run, local):
    result = dict(state='not_installed', address=None, port=None, existing=False)
    if not binary:
        return result
    try:
        status = json.loads(run(binary, 'status', '--json'))
        if status.get('BackendState') != 'Running':
            return dict(result, state='signed_out')
        host = (status.get('Self', {}).get('DNSName') or '').rstrip('.')
        if not host or host not in status.get('CertDomains', []):
            return dict(result, state='https_off')
        serve = json.loads(run(binary, 'serve', 'status', '--json'))
        web, tcp = serve.get('Web', {}), serve.get('TCP', {})
        for port in (443, 8443, 10443):
            key = f'{host}:{port}'
            handler = web.get(key, {}).get('Handlers', {}).get('/')
            if handler == {'Proxy': local} and not serve.get('AllowFunnel', {}).get(key):
                return dict(result, state='ready', address=f'https://{key}', port=port,
                            existing=True)
        for port in (443, 8443, 10443):
            if str(port) not in tcp and not any(k.endswith(f':{port}') for k in web):
                return dict(result, state='ready', address=f'https://{host}:{port}', port=port)
        return dict(result, state='unknown')
    except (OSError, subprocess.SubprocessError, ValueError, TypeError, AttributeError):
        return dict(result, state='unknown')


class Setup:
    def __init__(self, home, *, config_home=None, fetch=probe, run=command, binary=cli_path,
                 env=None, backfill=None, set_url=None):
        self.home = home
        self.config_home = config_home or (home.parent.parent if home.parent.name == 'profiles'
                                           else home)
        self.path = self.config_home / 'config.yaml'
        self.fetch, self.run, self.binary = fetch, run, binary
        self.env = os.environ if env is None else env
        self.backfill = backfill
        self.set_url = set_url or self._set_url

    def config(self):
        from ruamel.yaml import YAML

        yaml = YAML()
        # Hermes reads this file as YAML 1.1: an unquoted 'off' or 'yes' becomes a boolean.
        yaml.preserve_quotes = True
        data = self.path.read_bytes() if self.path.exists() else b''
        config = yaml.load(data) or {}
        if not isinstance(config, dict):
            raise ValueError('configuration must be a mapping')
        return yaml, data, config

    def _set_url(self, value):
        binary = shutil.which('hermes')
        if not binary:
            raise OSError('Hermes CLI is unavailable')
        args = ['config', 'unset', 'dashboard.public_url'] if value is None else [
            'config', 'set', 'dashboard.public_url', value]
        subprocess.run([binary, *args], check=True, capture_output=True, text=True,
                       timeout=30, env=child_env(HERMES_HOME=str(self.config_home)))

    def stored_url(self):
        return (self.config()[2].get('dashboard') or {}).get('public_url')

    def counts(self):
        pending = conflicts = 0
        for name in ('delegation', 'current-occurrences'):
            path = self.home / f'reminders-kanban/{name}.sqlite3'
            if not path.exists():
                continue
            with sqlite3.connect(f'{path.as_uri()}?mode=ro', uri=True) as db:
                for (raw,) in db.execute('SELECT state FROM delegated'):
                    row = json.loads(raw)
                    if (row.get('destination') and not row['destination'].get('url')
                            and row.get('status') != 'done'):
                        if row.get('backfill') == 'conflict':
                            conflicts += 1
                        elif row.get('backfill') != 'completed':
                            pending += 1
        return dict(pending=pending, conflicts=conflicts)

    def configuration(self):
        _, _, config = self.config()
        dashboard = config.get('dashboard') or {}
        address = self.env.get('HERMES_DASHBOARD_PUBLIC_URL') or dashboard.get('public_url')
        source = 'env' if self.env.get('HERMES_DASHBOARD_PUBLIC_URL') else (
            'config' if address else None)
        return address, source, dashboard

    def readiness(self, *, fresh=True):
        address, source, _ = self.configuration()
        status, reason = 'missing', None
        if address:
            reason = origin_error(address)
            status = 'invalid' if reason else 'restart_needed'
            if not reason:
                result = cached_check(self.config_home, address, self.fetch, fresh=fresh)
                if result['status'] == 'ok':
                    status = 'ready'
                else:
                    reason = result['status']
        mode = read_state(self.home).get('mode', 'none')
        if status == 'ready':
            mode = 'links'
        elif mode == 'local':
            status = 'local'
        if source == 'env':
            reason = 'env_override'
        return dict(status=status, address=address, source=source, reason=reason, mode=mode,
                    can_write=source != 'env')

    def inspect(self):
        result = self.readiness()
        _, _, dashboard = self.configuration()
        local = f'http://127.0.0.1:{int(dashboard.get("port", 9119))}'
        code, body = self.fetch(local)
        return dict(result,
                    dashboard=dict(running=code == 200, local=local, signin=signin(body)),
                    tailscale=tailscale(self.binary(), self.run, local), backfill=self.counts())

    def local(self):
        with setup_lock(self.config_home):
            state = read_state(self.home)
            state['mode'] = 'local'
            save_state(self.home, state)
        return dict(status='local')

    @contextmanager
    def attempt(self):
        state_path = self.home / 'reminders-kanban/link-setup.json'
        previous_state = state_path.read_bytes() if state_path.exists() else None
        receipt = dict(keep=False, handler=None, written=None, previous_url=None)
        try:
            yield receipt
        finally:
            if not receipt['keep']:
                try:
                    handler = receipt['handler']
                    if handler:
                        serve = json.loads(self.run(handler['binary'], 'serve', 'status', '--json'))
                        key = urlsplit(handler['address']).netloc
                        if (serve.get('Web', {}).get(key, {}).get('Handlers')
                                == {'/': {'Proxy': handler['local']}}):
                            self.run(handler['binary'], 'serve',
                                     f'--https={handler["port"]}', 'off')
                finally:
                    if (receipt['written'] is not None
                            and self.stored_url() == receipt['written']):
                        self.set_url(receipt['previous_url'])
                    if previous_state is None:
                        state_path.unlink(missing_ok=True)
                    else:
                        atomic(state_path, previous_state)

    def apply(self, mode, address=None, expected=None):
        with setup_lock(self.config_home):
            current = self.inspect()
            if not current['can_write']:
                return dict(status='env_override')
            if not current['dashboard']['running']:
                return dict(status='no_dashboard')
            if not current['dashboard']['signin']:
                return dict(status='no_signin')
            ts = current['tailscale']
            if mode == 'tailscale':
                if ts['state'] != 'ready' or expected != ts['address']:
                    return dict(status='stale')
                address = expected
            error = origin_error(address)
            if error:
                return dict(status=error)
            if (current['dashboard']['signin'] == 'password'
                    and not urlsplit(address).hostname.endswith('.ts.net')):
                return dict(status='password_on_public')
            if mode == 'own':
                result = check(address, self.fetch)
                if result['status'] not in {'ok', 'restart_needed'}:
                    return result
            previous_url = self.stored_url()
            state = read_state(self.home)
            with self.attempt() as receipt:
                if current['address'] != address:
                    state.pop('handler', None)
                    state.pop('backup', None)
                    state.pop('written', None)
                    state.update(address=address, previous_url=previous_url)
                    receipt.update(written=address, previous_url=previous_url)
                    self.set_url(address)
                    if self.stored_url() != address:
                        raise OSError('Hermes did not save the requested task-link address')
                    save_state(self.home, state)
                if 'previous_url' not in state:
                    state = dict(mode=state.get('mode', 'none'), address=address,
                                 previous_url=previous_url)
                    save_state(self.home, state)
                reply = dict(address=address)
                code, body = self.fetch(current['dashboard']['local'], urlsplit(address).netloc)
                if code != 200 or body.get('auth_required') is not True or not signin(body):
                    receipt['keep'] = True
                    return dict(reply, status='restart_needed')
                if mode == 'tailscale':
                    binary = self.binary()
                    if not ts['existing']:
                        fresh = tailscale(binary, self.run, current['dashboard']['local'])
                        if fresh != ts:
                            return dict(status='stale')
                        state['handler'] = dict(binary=binary, port=ts['port'], address=address,
                                                local=current['dashboard']['local'])
                        receipt['handler'] = state['handler']
                        save_state(self.home, state)
                        self.run(binary, 'serve', '--bg', f'--https={ts["port"]}',
                                 current['dashboard']['local'])
                    serve = json.loads(self.run(binary, 'serve', 'status', '--json'))
                    key = urlsplit(address).netloc
                    if serve.get('AllowFunnel', {}).get(key):
                        return dict(status='funnel_on')
                    if (serve.get('Web', {}).get(key, {}).get('Handlers', {}).get('/')
                            != {'Proxy': current['dashboard']['local']}):
                        return dict(status='stale')
                result = cached_check(self.config_home, address, self.fetch, fresh=True)
                if result['status'] != 'ok':
                    receipt['keep'] = True
                    return dict(reply, status='restart_needed', reason=result['status'])
                state['mode'] = 'links'
                save_state(self.home, state)
                receipt['keep'] = True
                if self.backfill:
                    self.backfill(address)
                return dict(reply, status='ready')

    def undo(self):
        with setup_lock(self.config_home):
            state = read_state(self.home)
            if (self.env.get('HERMES_DASHBOARD_PUBLIC_URL') or 'previous_url' not in state
                    or self.stored_url() not in (state.get('address'), state.get('previous_url'))):
                return dict(status='changed_since')
            handler = state.get('handler')
            if handler:
                serve = json.loads(self.run(handler['binary'], 'serve', 'status', '--json'))
                key = urlsplit(handler['address']).netloc
                route = serve.get('Web', {}).get(key)
                if route is not None:
                    if route.get('Handlers') != {'/': {'Proxy': handler['local']}}:
                        return dict(status='changed_since')
                    self.run(handler['binary'], 'serve', f'--https={handler["port"]}', 'off')
                # A prior undo may have removed our route before the CLI failed.
            if self.stored_url() != state['previous_url']:
                self.set_url(state['previous_url'])
            if self.stored_url() != state['previous_url']:
                raise OSError('Hermes did not restore the previous task-link address')
            save_state(self.home, {'mode': 'none'})
            return dict(status='undone')
