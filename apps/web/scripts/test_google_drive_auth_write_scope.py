#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
AUTH_FN = ROOT / "supabase" / "functions" / "google-drive-auth" / "index.ts"


def main() -> None:
    text = AUTH_FN.read_text(encoding="utf-8")
    required = [
        "https://ai.banhmique.vn",
        "https://www.googleapis.com/auth/drive email profile",
        "prompt', 'consent'",
        "google_drive_refresh_token",
    ]
    missing = [marker for marker in required if marker not in text]
    if missing:
        raise AssertionError(f"google-drive-auth missing markers: {missing}")
    if "https://www.googleapis.com/auth/drive.readonly email profile" in text:
        raise AssertionError("Drive OAuth scope must not be readonly for export/create Sheet flow")
    print("google drive auth write-scope checks passed")


if __name__ == "__main__":
    main()
