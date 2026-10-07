---
title: "Reconnect Buffer"
group: fix_it
screen: connect
last_checked: 2026-09-26
keywords: buffer, reconnect, key, not working, red
fix: connect-buffer
---

Buffer stopped accepting the dashboard's key. Planned posts wait safely.

## The card says what's wrong

![Step 1](/help/screenshots/reconnect-buffer-1.png)
<!-- api: POST /api/connections/buffer/key {"key":"bad-key-help-demo"} -->
<!-- target: .card:has(h3:text-is("Buffer")) -->

Open **Settings**, **Connect accounts**. The **Buffer** card says the key isn't working.

## Delete the old key and create a new one

![Step 2](/help/screenshots/reconnect-buffer-2.png)
<!-- mock: buffer-new-key -->

Log in to Buffer. Delete the old key and create a new one, then copy the key.

## Paste the new key

![Step 3](/help/screenshots/reconnect-buffer-3.png)
<!-- api: POST /api/connections/buffer/key {"key":"bad-key-help-demo"} -->
<!-- target: role=textbox[name="Posting · Buffer key"] -->

Tap **Disconnect** if you see it, paste the new key and tap **Check key**.

## The light turns green

![Step 4](/help/screenshots/reconnect-buffer-4.png)
<!-- route: /settings -->
<!-- api: POST /api/connections/buffer/key {"key":"good-key-e2e-000"} -->
<!-- target: [data-health="Buffer"] -->

The card turns green, and so does its light on **Settings**.

## Did this work?

If not, tap **No** below and we'll open the matching fix-it guide or email your helper.
