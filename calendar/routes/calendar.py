from fastapi import APIRouter, Request, HTTPException
from services.google_calendar import get_calendar_service

router = APIRouter(prefix="/calendar")


@router.get("/events")
def get_events(request: Request):
    tokens = request.session.get("tokens")
    if not tokens:
        raise HTTPException(status_code=401, detail="Not authenticated")

    service = get_calendar_service(tokens)
    events = service.list_upcoming_events()
    return {"events": events}


@router.get("/busy")
def get_busy(request: Request):
    tokens = request.session.get("tokens")
    if not tokens:
        raise HTTPException(status_code=401, detail="Not authenticated")

    service = get_calendar_service(tokens)
    busy = service.get_busy_times()
    return {"busy": busy}
