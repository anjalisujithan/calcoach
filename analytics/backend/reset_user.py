"""
reset_user.py — delete all Firestore data for a given user email.
Usage: python reset_user.py oindree@berkeley.edu
"""
import asyncio
import os
import sys

os.environ.setdefault("FIREBASE_SERVICE_ACCOUNT_PATH", "/Users/indra/calcoach/analytics/backend/serviceAccount.json")
os.environ.setdefault("FIRESTORE_DATABASE_ID", "calcoach")

from firestore_client import get_db

EMAIL = sys.argv[1] if len(sys.argv) > 1 else "oindree@berkeley.edu"


async def main():
    db = get_db()
    email = EMAIL.strip().lower()
    print(f"Deleting all data for: {email}")

    # Delete single-document collections keyed by email
    for collection in ("users", "local_users", "shared_availability"):
        ref = db.collection(collection).document(email)
        doc = await ref.get()
        if doc.exists:
            await ref.delete()
            print(f"  deleted {collection}/{email}")
        else:
            print(f"  {collection}/{email} — not found, skipping")

    # Delete reflections where user_id == email
    count = 0
    async for doc in db.collection("reflections").where("user_id", "==", email).stream():
        await doc.reference.delete()
        count += 1
    print(f"  deleted {count} reflections")

    # Delete shared_event_invites where requester_email == email
    count = 0
    async for doc in db.collection("shared_event_invites").where("requester_email", "==", email).stream():
        await doc.reference.delete()
        count += 1
    print(f"  deleted {count} shared_event_invites")

    print("Done. The app will treat this email as a new user on next login.")


asyncio.run(main())
