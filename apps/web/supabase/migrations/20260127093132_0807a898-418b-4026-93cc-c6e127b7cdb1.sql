-- Ensure realtime sends all columns in payload for reliable version sync
ALTER TABLE app_settings REPLICA IDENTITY FULL;