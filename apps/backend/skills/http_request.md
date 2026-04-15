---
name: http_request
description: Make an authenticated HTTP request to the Chatarmin API
---

# HTTP Request

Makes an HTTP request to the specified URL with optional authentication.

## Parameters
- `url` (required) — Full URL to request
- `method` — HTTP method (default: GET)
- `body` — JSON body for POST/PUT/PATCH
- `headers` — Additional headers (JSON object)

## Authentication
Includes `Authorization: Bearer {{secrets.chatarmin_api_key}}` by default.
