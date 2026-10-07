---
title: "Reconnect Vizard"
group: fix_it
screen: connect
last_checked: 2026-09-26
keywords: vizard, reconnect, key, not working, red
fix: connect-vizard
---

Vizard's key stopped working or it's out of credits. The built-in editor does its job meanwhile.

## The card says what's wrong

![Step 1](/help/screenshots/reconnect-vizard-1.png)
<!-- api: POST /api/connections/vizard/key {"key":"bad-key-help-demo"} -->
<!-- target: .card:has(h3:text-is("Vizard")) -->

Open **Settings**, **Connect accounts**. The **Vizard** card says the key isn't working.

## Top up, or make a new key

![Step 2](/help/screenshots/reconnect-vizard-2.png)
<!-- mock: vizard-credits -->

Log in to Vizard. Top up, or make a new key, then copy the key.

## Paste the new key

![Step 3](/help/screenshots/reconnect-vizard-3.png)
<!-- api: POST /api/connections/vizard/key {"key":"bad-key-help-demo"} -->
<!-- target: role=textbox[name="Editor · Vizard key"] -->

Tap **Disconnect** if you see it, paste the new key and tap **Check key**.

## The light turns green

![Step 4](/help/screenshots/reconnect-vizard-4.png)
<!-- route: /settings -->
<!-- api: POST /api/connections/vizard/key {"key":"good-vizard-demo-key"} -->
<!-- target: [data-health="vizard"] -->

The card turns green, and so does its light on **Settings**.

## Did this work?

If not, tap **No** below and we'll open the matching fix-it guide or email your helper.
