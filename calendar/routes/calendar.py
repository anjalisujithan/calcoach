from datetime import datetime, timedelta
from fastapi import APIRouter, Request, HTTPException, Query
from pydantic import BaseModel
from services.google_calendar import get_calendar_service

router = APIRouter(prefix="/calendar")


class NewEvent(BaseModel):
    title: str
    description: str = ""
    location: str = ""
    locationType: str = "room"  # "room" | "meeting_link" | "address"
    timezone: str = "America/Los_Angeles"
    calendarId: str = "primary"
    visibility: str = "default"  # "default" | "public" | "private"
    date: str        # "yyyy-MM-dd"
    startHour: int
    startMin: int
    durationMins: int
    recurrence: list[str] = []  # e.g. ["RRULE:FREQ=WEEKLY;BYDAY=MO,WE"]
    color: str = "#4285f4"


@router.get("/calendars")
def list_calendars(request: Request):
    tokens = request.session.get("tokens")
    if not tokens:
        raise HTTPException(status_code=401, detail="Not authenticated")
    service = get_calendar_service(tokens)
    return {"calendars": service.get_calendar_list()}


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


@router.get("/events/{event_id}")
def get_event(
    request: Request,
    event_id: str,
    calendarId: str = Query(default="primary"),
):
    tokens = request.session.get("tokens")
    if not tokens:
        raise HTTPException(status_code=401, detail="Not authenticated")
    service = get_calendar_service(tokens)
    event = service.get_event(event_id, calendar_id=calendarId)
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    return {"event": event}


@router.delete("/events/{event_id}")
def delete_event(
    request: Request,
    event_id: str,
    calendarId: str = Query(default="primary"),
):
    tokens = request.session.get("tokens")
    if not tokens:
        raise HTTPException(status_code=401, detail="Not authenticated")
    service = get_calendar_service(tokens)
    service.delete_event(event_id, calendar_id=calendarId)
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
        location=body.location,
        location_type=body.locationType,
        timezone=body.timezone,
        visibility=body.visibility,
        calendar_id=body.calendarId,
        recurrence=body.recurrence,
        color=body.color,
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
        location=body.location,
        location_type=body.locationType,
        timezone=body.timezone,
        visibility=body.visibility,
        calendar_id=body.calendarId,
        recurrence=body.recurrence,
        color=body.color,
    )
    return {"event": event}
