import importlib.util
import sys
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

API_FILE = Path(__file__).resolve().parent.parent / "dashboard" / "plugin_api.py"


def load_like_hermes():
    name = "hermes_dashboard_plugin_reminders-kanban"
    spec = importlib.util.spec_from_file_location(name, API_FILE)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def test_plugin_api_mounts_under_plugin_prefix():
    app = FastAPI()
    app.include_router(load_like_hermes().router, prefix="/api/plugins/reminders-kanban")
    response = TestClient(app).get("/api/plugins/reminders-kanban/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
