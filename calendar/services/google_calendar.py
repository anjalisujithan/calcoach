from datetime import datetime, timezone, timedelta
from typing import Optional
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.discovery_cache.base import Cache
from googleapiclient.errors import HttpError


class _MemoryCache(Cache):
    """In-process cache for the Google API discovery document.

    Without this, googleapiclient re-fetches the discovery document on every
    build() call, adding several hundred milliseconds of network latency to
    every add/delete/edit request.
    """
    _store: dict = {}

    def get(self, url: str):
        return self._store.get(url)

    def set(self, url: str, content) -> None:
        self._store[url] = content


_discovery_cache = _MemoryCache()


def get_calendar_service(tokens: dict):
    creds = Credentials(
        token=tokens["access_token"],
        refresh_token=tokens["refresh_token"],
        token_uri=tokens["token_uri"],
        client_id=tokens["client_id"],
        client_secret=tokens["client_secret"],
        scopes=tokens["scopes"],
    )
    return GoogleCalendarService(creds)


# Default full sync window: ~3 years each way.
_DEFAULT_SYNC_DAYS_BACK = 1095
_DEFAULT_SYNC_DAYS_AHEAD = 1095


class GoogleCalendarService:
    def __init__(self, creds: Credentials):
        self.service = build("calendar", "v3", credentials=creds, cache=_discovery_cache)

    def get_calendar_list(self) -> list:
        result = self.service.calendarList().list().execute()
        return [
            {
                "id": cal["id"],
                "summary": cal.get("summary", cal["id"]),
                "backgroundColor": cal.get("backgroundColor"),
                "accessRole": cal.get("accessRole", "reader"),
                "primary": cal.get("primary", False),
            }
            for cal in result.get("items", [])
        ]

    def list_upcoming_events(
        self,
        days_back: int = _DEFAULT_SYNC_DAYS_BACK,
        days_ahead: int = _DEFAULT_SYNC_DAYS_AHEAD,
        max_results: int = 2500,
    ) -> list:
        now = datetime.now(timezone.utc)
        time_min = (now - timedelta(days=days_back)).isoformat()
        time_max = (now + timedelta(days=days_ahead)).isoformat()

        calendars = self.get_calendar_list()
        per_cal = max(100, max_results // max(len(calendars), 1))
        all_events: list = []

        for cal in calendars:
            try:
                result = (
                    self.service.events()
                    .list(
                        calendarId=cal["id"],
                        timeMin=time_min,
                        timeMax=time_max,
                        maxResults=per_cal,
                        singleEvents=True,
                        orderBy="startTime",
                    )
                    .execute()
                )
                events = result.get("items", [])
                for e in events:
                    e["_calendarId"] = cal["id"]
                all_events.extend(events)
            except HttpError:
                pass  # skip calendars with permission issues

        all_events.sort(
            key=lambda e: e.get("start", {}).get("dateTime", e.get("start", {}).get("date", ""))
        )
        return all_events

    def list_events_between(self, time_min: str, time_max: str, max_results: int = 500) -> list:
        result = (
            self.service.events()
            .list(
                calendarId="primary",
                timeMin=time_min,
                timeMax=time_max,
                maxResults=max_results,
                singleEvents=True,
                orderBy="startTime",
            )
            .execute()
        )
        return result.get("items", [])

    def get_event(self, event_id: str, calendar_id: str = "primary") -> Optional[dict]:
        try:
            return self.service.events().get(calendarId=calendar_id, eventId=event_id).execute()
        except HttpError as e:
            if getattr(e.resp, "status", None) in (404, 410):
                return None
            raise

    def get_busy_times(self, days_ahead: int = 7) -> list:
        now = datetime.now(timezone.utc)
        time_max = (now + timedelta(days=days_ahead)).isoformat()
        body = {
            "timeMin": now.isoformat(),
            "timeMax": time_max,
            "items": [{"id": "primary"}],
        }
        result = self.service.freebusy().query(body=body).execute()
        return result.get("calendars", {}).get("primary", {}).get("busy", [])

    def delete_event(self, event_id: str, calendar_id: str = "primary") -> None:
        try:
            self.service.events().delete(calendarId=calendar_id, eventId=event_id).execute()
        except HttpError as e:
            # Already removed (double-delete, sync lag, or other client) — treat as success
            if getattr(e.resp, "status", None) in (404, 410):
                return
            raise

    def update_event(self, event_id: str, summary: str, start: str, end: str, description: str = "", location: str = "", location_type: str = "room", timezone: str = "America/Los_Angeles", visibility: str = "default", calendar_id: str = "primary", recurrence: list = []) -> dict:
        body = {
            "summary": summary,
            "description": description,
            "location": location,
            "visibility": visibility,
            "start": {"dateTime": start, "timeZone": timezone},
            "end": {"dateTime": end, "timeZone": timezone},
            "extendedProperties": {
                "private": {"locationType": location_type}
            },
        }
        if recurrence:
            body["recurrence"] = recurrence
        return self.service.events().patch(calendarId=calendar_id, eventId=event_id, body=body).execute()

    def add_event(self, summary: str, start: str, end: str, description: str = "", location: str = "", location_type: str = "room", timezone: str = "America/Los_Angeles", visibility: str = "default", calendar_id: str = "primary", recurrence: list = []) -> dict:
        event = {
            "summary": summary,
            "description": description,
            "location": location,
            "visibility": visibility,
            "start": {"dateTime": start, "timeZone": timezone},
            "end": {"dateTime": end, "timeZone": timezone},
            "colorId": "9",
            "extendedProperties": {
                "private": {"calcoach": "true", "locationType": location_type}
            },
        }
        if recurrence:
            event["recurrence"] = recurrence
        return self.service.events().insert(calendarId=calendar_id, body=event).execute()
