from datetime import datetime, timezone, timedelta
from typing import Optional
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError


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
        self.service = build("calendar", "v3", credentials=creds)

    def list_upcoming_events(
        self,
        days_back: int = _DEFAULT_SYNC_DAYS_BACK,
        days_ahead: int = _DEFAULT_SYNC_DAYS_AHEAD,
        max_results: int = 2500,
    ) -> list:
        now = datetime.now(timezone.utc)
        time_min = (now - timedelta(days=days_back)).isoformat()
        time_max = (now + timedelta(days=days_ahead)).isoformat()
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

    def get_event(self, event_id: str) -> Optional[dict]:
        try:
            return self.service.events().get(calendarId="primary", eventId=event_id).execute()
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

    def delete_event(self, event_id: str) -> None:
        try:
            self.service.events().delete(calendarId="primary", eventId=event_id).execute()
        except HttpError as e:
            # Already removed (double-delete, sync lag, or other client) — treat as success
            if getattr(e.resp, "status", None) in (404, 410):
                return
            raise

    def update_event(self, event_id: str, summary: str, start: str, end: str, description: str = "", recurrence: list = []) -> dict:
        body = {
            "summary": summary,
            "description": description,
            "start": {"dateTime": start, "timeZone": "America/Los_Angeles"},
            "end": {"dateTime": end, "timeZone": "America/Los_Angeles"},
        }
        if recurrence:
            body["recurrence"] = recurrence
        return self.service.events().patch(calendarId="primary", eventId=event_id, body=body).execute()

    def add_event(self, summary: str, start: str, end: str, description: str = "", recurrence: list = []) -> dict:
        event = {
            "summary": summary,
            "description": description,
            "start": {"dateTime": start, "timeZone": "America/Los_Angeles"},
            "end": {"dateTime": end, "timeZone": "America/Los_Angeles"},
            "colorId": "9",
            "extendedProperties": {
                "private": {"calcoach": "true"}
            }
        }
        if recurrence:
            event["recurrence"] = recurrence
        return self.service.events().insert(calendarId="primary", body=event).execute()
