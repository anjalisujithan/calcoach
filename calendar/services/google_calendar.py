from datetime import datetime, timezone, timedelta
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build


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


class GoogleCalendarService:
    def __init__(self, creds: Credentials):
        self.service = build("calendar", "v3", credentials=creds)

    def list_upcoming_events(self, max_results: int = 10) -> list:
        now = datetime.now(timezone.utc).isoformat()
        result = (
            self.service.events()
            .list(
                calendarId="primary",
                timeMin=now,
                maxResults=max_results,
                singleEvents=True,
                orderBy="startTime",
            )
            .execute()
        )
        return result.get("items", [])

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

    def add_event(self, summary: str, start: str, end: str, description: str = "") -> dict:
        event = {
            "summary": summary,
            "description": description,
            "start": {"dateTime": start, "timeZone": "America/Los_Angeles"},
            "end": {"dateTime": end, "timeZone": "America/Los_Angeles"},
            "colorId": "9",  # blueberry — visually distinct
            "extendedProperties": {
                "private": {"calcoach": "true"}
            }
        }
        return self.service.events().insert(calendarId="primary", body=event).execute()
