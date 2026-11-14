"""Click-driven task-link setup; GET never mutates setup or reminders."""

import subprocess
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, ConfigDict

from reminders_kanban.api.preview import Home
from reminders_kanban.links.setup import Setup, check

router = APIRouter()


class Check(BaseModel):
    model_config = ConfigDict(extra='forbid')
    address: str


class Apply(BaseModel):
    model_config = ConfigDict(extra='forbid')
    mode: Literal['tailscale', 'own']
    address: str | None = None
    expected: str | None = None


def service(home: Home):
    if home is None:
        return None

    def backfill(address):
        from reminders_kanban.api.delegation import service as one_off
        from reminders_kanban.api.occurrence import service as recurring

        for factory in (one_off, recurring):
            owner = factory(home)
            if owner:
                owner.backfill_links(address)

    return Setup(home, backfill=backfill)


Service = Annotated[Setup | None, Depends(service)]


def run(response, owner, operation):
    response.headers['Cache-Control'] = 'no-store'
    if owner is None:
        return dict(status='unavailable')
    try:
        return operation()
    except (OSError, ValueError, subprocess.SubprocessError):
        return dict(status='unavailable')


@router.get('/task-links/setup')
def get_setup(response: Response, owner: Service):
    return run(response, owner, lambda: owner.inspect())


@router.post('/task-links/setup/check')
def check_setup(body: Check, response: Response, owner: Service):
    return run(response, owner, lambda: check(body.address, owner.fetch))


@router.post('/task-links/setup/apply')
def apply_setup(body: Apply, response: Response, owner: Service):
    return run(response, owner, lambda: owner.apply(**body.model_dump()))


@router.post('/task-links/setup/undo')
def undo_setup(response: Response, owner: Service):
    return run(response, owner, lambda: owner.undo())


@router.post('/task-links/setup/local')
def local_setup(response: Response, owner: Service):
    return run(response, owner, lambda: owner.local())
