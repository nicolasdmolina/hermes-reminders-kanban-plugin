"""User-triggered, per-user native helper setup. GET inspection never prepares it."""

from __future__ import annotations

import fcntl
import json
import os
import platform
import plistlib
import re
import secrets
import subprocess
import tempfile
from pathlib import Path

from reminders_kanban.process_env import child_env
from reminders_kanban.reminders import helper

IDENTITY_NAME = "Reminders Kanban Dev"
SETUP_DIR = Path.home() / "Library/Application Support/reminders-kanban/helper-setup"
MESSAGES = {
    "toolchain_required": "Install Apple's Command Line Tools, then prepare Reminders access.",
    "signing_required": "Prepare Reminders access to set up this Mac's local signing identity.",
    "setup_failed": (
        "Reminders access setup did not finish. Unlock your login keychain and try again."
    ),
    "unsupported_platform": "Reminders access requires macOS 14 or later.",
    "session_locked": "Unlock this Mac and keep it signed in while preparing Reminders access.",
}


def _run(args, *, timeout=20, check=True, env=None):
    return subprocess.run(args, check=check, capture_output=True, text=True, timeout=timeout,
                          env=child_env(**(env or {})))


def _result(status):
    return {"status": status, **({"message": MESSAGES[status]} if status in MESSAGES else {})}


def session_available():
    body = _run(["/usr/sbin/ioreg", "-n", "Root", "-d1", "-a"]).stdout
    root = plistlib.loads(body.encode())
    if isinstance(root, list):
        root = root[0] if root else {}
    if not isinstance(root, dict):
        return False
    return root.get("IOConsoleLocked") is False and any(
        user.get("kCGSSessionOnConsoleKey") is True
        and user.get("kCGSSessionUserIDKey") == os.getuid()
        and not user.get("CGSSessionScreenIsLocked", False)
        for user in root.get("IOConsoleUsers", [])
        if isinstance(user, dict)
    )


def toolchain_available():
    try:
        _run(["/usr/bin/xcode-select", "-p"])
        compiler = _run(["/usr/bin/xcrun", "--find", "swiftc"]).stdout.strip()
        return bool(compiler) and Path(compiler).is_file()
    except (OSError, subprocess.SubprocessError):
        return False


def _pin():
    path = SETUP_DIR / "identity.json"
    if not path.exists():
        return None
    value = json.loads(path.read_text())
    if not re.fullmatch(r"[A-F0-9]{40}", value["fingerprint"]):
        raise ValueError("Invalid helper identity record")
    return value


def _save_pin(fingerprint, *, generated):
    value = {"fingerprint": fingerprint, "generated": generated}
    path = SETUP_DIR / "identity.json"
    with tempfile.NamedTemporaryFile(mode="w", dir=SETUP_DIR, delete=False) as stream:
        temporary = Path(stream.name)
        json.dump(value, stream)
    try:
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def signing_identity(*, valid=True):
    """Select a fingerprint, never a partial certificate name or an arbitrary match."""
    pin = _pin()
    requested = os.environ.get("RK_SIGNING_IDENTITY", IDENTITY_NAME)
    args = ["/usr/bin/security", "find-identity", "-p", "codesigning"]
    if valid:
        args.append("-v")
    output = _run(args).stdout
    identities = re.findall(r'^\s*\d+\) ([A-Fa-f0-9]{40}) "([^"\n]+)"', output, re.M)
    matches = {
        fingerprint.upper()
        for fingerprint, name in identities
        if (fingerprint.upper() == requested.upper() or name == requested)
        and (not pin or fingerprint.upper() == pin["fingerprint"])
    }
    if len(matches) > 1:
        raise helper.HelperError(
            "setup_failed", "Multiple helper signing identities need attention",
        )
    return next(iter(matches), None)


def supported_platform():
    if platform.system() != "Darwin":
        return False
    try:
        return int(platform.mac_ver()[0].split(".")[0]) >= 14
    except (ValueError, IndexError):
        return False


def prerequisite():
    if not supported_platform():
        return "unsupported_platform"
    try:
        if not session_available():
            return "session_locked"
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        return "session_locked"
    if not toolchain_available():
        return "toolchain_required"
    return None


def inspect():
    """Inspect existing state without creating files, prompting, compiling or launching."""
    try:
        if status := prerequisite():
            return _result(status)
        identity = signing_identity()
        if not identity:
            return _result("signing_required")
        app = helper._build_dir(identity) / helper.APP_NAME
        if not app.exists():
            return _result("signing_required")
        helper._verify(app, identity)
        return _result("ready")
    except helper.HelperError as exc:
        return _result(exc.code if exc.code in MESSAGES else "setup_failed")
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        return _result("setup_failed")


def _login_keychain():
    path = Path.home() / "Library/Keychains/login.keychain-db"
    if not path.is_file():
        raise helper.HelperError("setup_failed", "A login keychain is required")
    return path


def _create_identity():
    pin = _pin()
    if (pin and not pin["generated"]) or (
        os.environ.get("RK_SIGNING_IDENTITY", IDENTITY_NAME) != IDENTITY_NAME
    ):
        raise helper.HelperError("signing_required", "The selected identity needs keychain repair")
    existing = _run(
        ["/usr/bin/security", "find-certificate", "-a", "-c", IDENTITY_NAME], check=False,
    )
    if existing.returncode not in (0, 44):
        raise helper.HelperError("setup_failed", "The login keychain is unavailable")
    if existing.stdout:
        raise helper.HelperError("signing_required", "An existing helper certificate needs repair")
    keychain = _login_keychain()
    with tempfile.TemporaryDirectory(prefix="identity-", dir=SETUP_DIR) as temporary:
        root = Path(temporary)
        config = root / "certificate.cnf"
        config.write_text(
            "[req]\nprompt=no\ndistinguished_name=subject\nx509_extensions=signing\n"
            f"[subject]\nCN={IDENTITY_NAME}\n[signing]\nbasicConstraints=critical,CA:false\n"
            "keyUsage=critical,digitalSignature\nextendedKeyUsage=critical,codeSigning\n"
        )
        key, certificate, archive = (
            root / name for name in ("key.pem", "cert.pem", "identity.p12")
        )
        _run([
            "/usr/bin/openssl", "req", "-new", "-x509", "-newkey", "rsa:3072", "-nodes",
            "-sha256", "-days", "3650", "-config", str(config), "-keyout", str(key),
            "-out", str(certificate),
        ], timeout=60)
        # The enclosing directory is 0700; the key and archive never leave this operation.
        key.chmod(0o600)
        # macOS 26 refuses to import an archive with an empty password. This one-time password
        # protects only the temporary archive, which is deleted with this directory.
        passphrase = secrets.token_urlsafe(24)
        _run([
            "/usr/bin/openssl", "pkcs12", "-export", "-inkey", str(key), "-in", str(certificate),
            "-out", str(archive), "-passout", "env:RK_ARCHIVE_PASSPHRASE",
        ], env={"RK_ARCHIVE_PASSPHRASE": passphrase})
        archive.chmod(0o600)
        der = _run([
            "/usr/bin/openssl", "x509", "-in", str(certificate), "-fingerprint", "-sha1", "-noout",
        ]).stdout
        fingerprint = der.strip().split("=")[-1].replace(":", "").upper()
        if not re.fullmatch(r"[A-F0-9]{40}", fingerprint):
            raise ValueError("Invalid generated certificate fingerprint")
        (SETUP_DIR / "certificate.pem").write_bytes(certificate.read_bytes())
        _save_pin(fingerprint, generated=True)
        _run([
            "/usr/bin/security", "import", str(archive), "-k", str(keychain), "-f", "pkcs12",
            "-P", passphrase, "-x", "-T", "/usr/bin/codesign",
        ], timeout=60)
    return fingerprint


def _trust_generated(fingerprint):
    pin = _pin()
    if not pin or not pin["generated"] or fingerprint != pin["fingerprint"]:
        raise helper.HelperError("signing_required", "An existing identity needs keychain repair")
    certificate = SETUP_DIR / "certificate.pem"
    # Check the public certificate on disk before granting codeSign-only user-domain trust.
    digest = _run([
        "/usr/bin/openssl", "x509", "-in", str(certificate), "-fingerprint", "-sha1", "-noout",
    ]).stdout.strip().split("=")[-1].replace(":", "").upper()
    if digest != fingerprint:
        raise ValueError("Generated certificate changed")
    _run([
        "/usr/bin/security", "add-trusted-cert", "-r", "trustRoot", "-p", "codeSign",
        "-k", str(_login_keychain()), str(certificate),
    ], timeout=60)


def prepare(action):
    """Only an explicit POST calls this. OS Keychain consent remains in place."""
    try:
        if not supported_platform():
            return _result("unsupported_platform")
        try:
            if not session_available():
                return _result("session_locked")
        except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
            return _result("session_locked")
        SETUP_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
        with (SETUP_DIR / "setup.lock").open("a") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return {
                    "status": "setup_failed",
                    "message": "Setup is already running. Try again shortly.",
                }
            if not toolchain_available():
                if action == "install_tools":
                    _run(["/usr/bin/xcode-select", "--install"])
                return _result("toolchain_required")
            if action == "install_tools":
                return inspect()
            identity = signing_identity()
            if not identity:
                identity = signing_identity(valid=False)
                if not identity:
                    identity = _create_identity()
                _trust_generated(identity)
                if signing_identity() != identity:
                    raise helper.HelperError(
                        "signing_required", "The signing identity is unavailable",
                    )
            if not _pin():
                _save_pin(identity, generated=False)
            helper.helper_app()
            return _result("ready")
    except helper.HelperError as exc:
        return _result(exc.code if exc.code in MESSAGES else "setup_failed")
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        return _result("setup_failed")
