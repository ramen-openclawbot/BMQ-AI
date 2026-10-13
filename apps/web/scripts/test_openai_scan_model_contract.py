#!/usr/bin/env python3
"""Deprecated alias for test_scan_ai_provider_contract.py.

The scan functions no longer share OPENAI_SCAN_MODEL directly: they read
endpoint/key/model from _shared/ai-vision-provider.ts (DeepSeek by default,
OpenAI when SCAN_AI_PROVIDER=openai). Keep this filename working for older
callers by delegating to the current contract test.
"""
from test_scan_ai_provider_contract import main

if __name__ == "__main__":
    main()
