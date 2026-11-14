"""Plugin router. Each feature module adds its own sub-router file here and one
include_router line below, so tickets add files instead of editing one router."""

from fastapi import APIRouter

from reminders_kanban.api import (
    attention,
    delegation,
    health,
    helper_setup,
    human,
    link_setup,
    model_choice,
    occurrence,
    preview,
    reconciliation,
    recovery,
    recurring,
    task_links,
    views,
)

router = APIRouter()
router.include_router(health.router)

router.include_router(preview.router)
router.include_router(views.router)
router.include_router(human.router)
router.include_router(link_setup.router)
router.include_router(task_links.router)

router.include_router(delegation.router)

router.include_router(recovery.router)
router.include_router(attention.router)
router.include_router(occurrence.router)

router.include_router(recurring.router)

router.include_router(reconciliation.router)

router.include_router(model_choice.router)

router.include_router(helper_setup.router)
