from datetime import datetime, timedelta
from fastapi import APIRouter, Request, HTTPException
from pydantic import BaseModel
from services.google_calendar import get_calendar_service

router = APIRouter(prefix="/calendar")


class NewEvent(BaseModel):
    title: str
    description: str = ""
    date: str        # "yyyy-MM-dd"
    startHour: int
    startMin: int
    durationMins: int
    recurrence: list[str] = []  # e.g. ["RRULE:FREQ=WEEKLY;BYDAY=MO,WE"]


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


@router.delete("/events/{event_id}")
def delete_event(request: Request, event_id: str):
    tokens = request.session.get("tokens")
    if not tokens:
        raise HTTPException(status_code=401, detail="Not authenticated")
    service = get_calendar_service(tokens)
    service.delete_event(event_id)
    return {"ok": True}


@router.patch("/events/{event_id}")
def update_event(request: Request, event_id: str, body: NewEvent):
    tokens = request.session.get("tokens")
    if not tokens:
        raise HTTPException(status_code=401, detail="Not authenticated")

    year, month, day = (int(p) for p in body.date.split("-"))
    start_dt = datetime(year, month, day, body.startHour, body.startMin)
    end_dt = start_dt + timedelta(minutes=body.durationMins)

    service = get_calendar_service(tokens)
    event = service.update_event(
        event_id=event_id,
        summary=body.title,
        start=start_dt.strftime("%Y-%m-%dT%H:%M:%S"),
        end=end_dt.strftime("%Y-%m-%dT%H:%M:%S"),
        description=body.description,
        recurrence=body.recurrence,
    )
    return {"event": event}


@router.post("/events")
def create_event(request: Request, body: NewEvent):
    tokens = request.session.get("tokens")
    if not tokens:
        raise HTTPException(status_code=401, detail="Not authenticated")

    year, month, day = (int(p) for p in body.date.split("-"))
    start_dt = datetime(year, month, day, body.startHour, body.startMin)
    end_dt = start_dt + timedelta(minutes=body.durationMins)

    service = get_calendar_service(tokens)
    event = service.add_event(
        summary=body.title,
        start=start_dt.strftime("%Y-%m-%dT%H:%M:%S"),
        end=end_dt.strftime("%Y-%m-%dT%H:%M:%S"),
        description=body.description,
        recurrence=body.recurrence,
    )
    return {"event": event}
