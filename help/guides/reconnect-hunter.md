---
title: "Reconnect Hunter"
group: fix_it
screen: connect
last_checked: 2026-09-26
keywords: hunter, reconnect, key, not working, red
fix: connect-hunter
---

The Hunter key stopped working. Everything else keeps working.

## The card says what's wrong

![Step 1](/help/screenshots/reconnect-hunter-1.png)
<!-- api: POST /api/connections/hunter/key {"key":"bad-key-help-demo"} -->
<!-- target: .card:has(h3:text-is("Hunter.io")) -->

Open **Settings**, **Connect accounts**. The **Hunter.io** card says the key isn't working.

## Generate a new key

![Step 2](/help/screenshots/reconnect-hunter-2.png)
<!-- mock: hunter-new-key -->

Log in to Hunter.io. Generate a new key, then copy the key.

## Paste the new key

![Step 3](/help/screenshots/reconnect-hunter-3.png)
<!-- api: POST /api/connections/hunter/key {"key":"bad-key-help-demo"} -->
<!-- target: role=textbox[name="Brand deals · Hunter.io key"] -->

Tap **Disconnect** if you see it, paste the new key and tap **Check key**.

## The light turns green

![Step 4](/help/screenshots/reconnect-hunter-4.png)
<!-- route: /settings -->
<!-- api: POST /api/connections/hunter/key {"key":"good-demo-hunter"} -->
<!-- target: [data-health="hunter"] -->

The card turns green, and so does its light on **Settings**.

## Did this work?

If not, tap **No** below and we'll open the matching fix-it guide or email your helper.
